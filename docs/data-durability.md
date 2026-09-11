# Backup, restore, rollback and point-in-time recovery

Huddle's mirrored Sleeper data is disposable: a synchronization rebuilds leagues, rosters, matchups and
players from upstream. Nothing else here is. Application accounts, sessions, the Sleeper association, a
league's scoring observations, weekly and roster history, forecast snapshots, the advice given under
them and how that advice turned out exist only in this database — Sleeper serves the current week, not
last November's.

So these procedures are a precondition, not an operational nicety. **Do not apply migration `0001` in
an environment that will hold real accounts until the checklist below is true**, because that migration
is the one that starts storing user-specific data.

## Before the first migration

- [ ] Automated base backups run on a schedule, to storage on a different host than the database.
- [ ] WAL archiving is on and archiving successfully, so recovery is not limited to the last base backup.
- [ ] A restore has been performed end to end, into a scratch database, by whoever will have to do it.
- [ ] Backup age and WAL archiving failures are alerted on. A backup nobody checks is not a backup.
- [ ] Backups are encrypted at rest, and their retention is stated (below).
- [ ] `DATABASE_URL` is injected as a secret, never committed, and never logged — the application logs
      the database name, not the connection string.

## What has to survive

| Data | If it is lost | Rebuildable |
| --- | --- | --- |
| `app_user`, `app_session`, `sleeper_account`, `app_user_league` | Nobody can sign in; every league link is gone | No |
| `league`, `roster`, `matchup`, `league_transaction`, `traded_draft_pick`, `player` | A synchronization refills them within one sweep | Yes, from Sleeper |
| `league_scoring_snapshot` | Every stored ranking cites rules nothing recorded | Only the current one |
| `weekly_snapshot`, `roster_history` | Past weeks are gone; Sleeper serves the current one | No |
| `forecast_snapshot`, `forecast_player` | A licensed source re-publishes the current week only | Current week only |
| `recommendation`, `recommendation_explanation`, `recommendation_outcome` | The record of what was advised, and whether it worked | No |
| `sync_run`, `resource_freshness` | Freshness reporting restarts from the next sweep | Partly |
| `sync_lease` | Nothing: leases expire by design | Yes |

Retention keeps this bounded — see [storage](storage.md#retention) — so a backup is a backup of what the
retention policy decided to keep, not of everything that ever happened.

## Backups

Two kinds, for two different failures.

**Physical, for point-in-time recovery.** A base backup plus archived WAL is what lets you recover to a
moment rather than to a nightly snapshot.

```bash
# Continuous archiving (postgresql.conf), then reload.
archive_mode = on
archive_command = 'test ! -f /backup/wal/%f && cp %p /backup/wal/%f'
wal_level = replica

# A base backup, weekly or nightly depending on how much WAL you are willing to replay.
pg_basebackup --pgdata=/backup/base/$(date -u +%Y%m%dT%H%M%SZ) \
  --format=tar --gzip --wal-method=stream --checkpoint=fast --progress
```

A managed provider (RDS, Cloud SQL, Neon, Crunchy) does this for you. Check two things rather than
assuming: that PITR is actually enabled, and what its retention window is.

**Logical, for portability and for restoring one table.** A custom-format dump restores selectively,
survives a major-version upgrade, and is what you want when a migration went wrong in one table rather
than the cluster.

```bash
pg_dump --format=custom --no-owner --file=huddle-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"
```

**Retention.** Keep at least: 7 daily, 4 weekly, and a WAL archive covering the whole window between
base backups. State the recovery point objective this buys — with WAL archiving it is seconds; with
nightly dumps alone it is up to a day.

## Restore

A backup is a hypothesis until it has been restored. Do this on a schedule, not only in an incident.

```bash
# Logical restore into a scratch database.
createdb huddle_restore_check
pg_restore --clean --if-exists --no-owner --dbname=huddle_restore_check huddle-20261006T030000Z.dump

# Then check what came back, before trusting it.
psql huddle_restore_check -c 'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
psql huddle_restore_check -c 'SELECT count(*) AS accounts FROM app_user'
psql huddle_restore_check -c "SELECT league_id, status, last_synced_at FROM league_connection ORDER BY league_id"
```

The schema version is the first thing to check: restoring a dump taken at `0007` into an application
expecting `0009` fails at the first query that touches a missing table, and the migration ledger says so
in one line.

After restoring into the live database, the application converges on its own. Connection reconciliation
runs on every sweep, so a store restored from a backup that predates a league link re-derives the
connection set without an operator reconciling it by hand. The mirrored resources refresh on their own
TTLs. Do check the sample-league opt-in is still off and that `STORAGE_ADAPTER` still names the adapter
you just restored into.

## Migration rollback

Every migration has a `down` file, and they are applied in reverse order, one version at a time.
[`apps/api/migrations/rollback.sh`](../apps/api/migrations/rollback.sh) does that from the ledger and
does nothing without `--yes`; see [`apps/api/migrations/README.md`](../apps/api/migrations/README.md)
for the mechanics and [`docs/deployment.md`](deployment.md) for the order to roll the application and
the schema back in.

**A rollback that drops a table destroys data the `up` cannot recreate.** So:

1. Take a fresh logical backup *and* a named restore point immediately before migrating:
   ```sql
   SELECT pg_create_restore_point('before-0007-recommendations');
   ```
2. Apply or roll back one version at a time, checking `schema_migrations` between each.
3. If a rollback would drop data you still need, recover to the restore point instead of rolling
   back — a `down` migration is a schema operation, not an undo.

**Prefer expand/contract for anything destructive.** A migration that renames or removes a column in one
step breaks every instance still running the previous release, in both directions. Add the new shape,
deploy code that writes both and reads the new, backfill, then remove the old shape in a later migration
once no running instance needs it. Only the last step is destructive, and by then it is reversible in
the only sense that matters: nothing depends on what it drops.

**Rolling back `0008` stops the mutual exclusion** a multi-instance deployment depends on: the lease
table is what keeps one worker in charge of the schedule. Stop every worker but one before that
rollback, or every instance will sweep at once.

## Point-in-time recovery

For the failures a backup alone does not cover: a migration that dropped the wrong thing, a retention
run pointed at the wrong window, a bad delete.

```bash
# 1. Stop the application. Recovering underneath a running instance loses the writes it makes meanwhile.
# 2. Restore the most recent base backup taken BEFORE the target time.
rm -rf /var/lib/postgresql/16/main
tar -xzf /backup/base/20261006T030000Z/base.tar.gz -C /var/lib/postgresql/16/main

# 3. Point recovery at the moment just before the damage (postgresql.conf).
restore_command = 'cp /backup/wal/%f %p'
recovery_target_time = '2026-10-06 14:32:00+00'   # or recovery_target_name = 'before-0007-recommendations'
recovery_target_action = 'promote'

# 4. Mark the cluster for recovery and start it.
touch /var/lib/postgresql/16/main/recovery.signal
pg_ctl -D /var/lib/postgresql/16/main start
```

Recovery replays WAL to the target and promotes. Before pointing the application at it, check
`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1` — recovering past a migration
means the schema is the older one, and the application has to be the matching release.

Recovering to a time *before* a migration and then re-applying it is the safe order. Recovering to a
time after it and rolling the migration back is not: the rollback drops what the migration created,
including anything written since.

## The local JSON adapter

The development profile has none of this, by design. Its durability story is one file:

```bash
cp data/store.json data/store.$(date -u +%Y%m%dT%H%M%SZ).json   # while the API is stopped
```

Writes are atomic within one process — temporary file, rename — so a copy taken at any moment is a
valid document rather than a half-written one. There is no point-in-time recovery, no rollback of a
retention run, and no way to recover a single league. That is one of the reasons `STORAGE_ADAPTER=json`
is refused for a multi-instance production deployment and warned about for a single-instance one; see
[storage](storage.md#choosing-an-adapter).

## Verifying this stays true

- Restore drill into a scratch database, monthly, by someone who has not done it before.
- Alert on backup age, on WAL archiving failures, and on the gap between the newest base backup and now.
- Re-run the drill after any change to the migration set, and run
  [`migrations/verify/run.sh`](../apps/api/migrations/verify/run.sh) against a throwaway database in CI:
  it applies every migration, rolls all of them back, and applies them again, so a rollback that only
  works on a fresh database fails there rather than here.
