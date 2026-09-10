# Migrations

PostgreSQL schema for the Huddle repository interfaces in [`../src/storage`](../src/storage). One
numbered pair per change: `NNNN_name.up.sql` applies it, `NNNN_name.down.sql` rolls it back.

Nothing runs these automatically. They are applied by an operator or a deployment step, before the
process that needs them starts — see [`docs/data-durability.md`](../../../docs/data-durability.md) for
what has to be true before the first one that stores user data is applied.

## Applying and rolling back

Each file opens its own transaction, so a failed migration leaves the database exactly as it was:

```bash
for file in migrations/*.up.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
```

Roll back in reverse order, one version at a time:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0007_recommendations.down.sql
```

`schema_migrations` is the ledger: every up file inserts its version, every down file deletes it. Ask
the database what it has rather than trusting a deployment log:

```sql
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;
```

A full rollback deliberately leaves `schema_migrations` itself behind — an empty ledger is a fact worth
keeping, and dropping it would make the next apply unable to tell a fresh database from a rolled-back
one.

`npm run migrations:check -w @sleeper/api` verifies the set is well formed: contiguous versions, an up
for every down, and a ledger statement in each. It is a lint, not an apply — it never connects to a
database.

## What is here

| Version | Covers |
| --- | --- |
| `0001` | Application accounts, sessions and CSRF digests, Sleeper account associations, league links |
| `0002` | League connections, mirrored league metadata, scoring snapshots |
| `0003` | League members, rosters, roster ownership, roster history |
| `0004` | The shared player directory, its refresh state, and the external identity alias map |
| `0005` | Matchups, transactions, traded draft picks, weekly observations |
| `0006` | Forecast snapshots and their per-player raw statistics |
| `0007` | Recommendations, their explanations, and their outcomes |
| `0008` | Synchronization runs, per-resource freshness, and the lease table |
| `0009` | Retention functions |

## Conventions

- **Owned rows are constrained; mirrored ids are indexed.** A foreign key means this application owns
  both ends. Sleeper ids that arrive on independent refresh intervals — a co-owner on a roster whose
  member list has not been refreshed yet — carry an index and no constraint, because a missing referent
  there is a freshness fact rather than corruption, and failing the write would fail the very
  synchronization that is about to fix it.
- **Observations are append-only.** Weekly snapshots, scoring snapshots, roster history, forecast
  snapshots and recommendation outcomes reject `UPDATE` through a trigger. Retention still deletes
  them; what is forbidden is quietly rewriting the provenance a ranking cites.
- **Authoritative sets are replaced in one transaction.** Traded draft picks are the clearest case: a
  pick that returns to its original owner disappears from Sleeper's response entirely, so the league's
  rows are deleted and reinserted together. Upserting alone would leave a returned pick showing its old
  owner forever, and doing it in two transactions would let a reader see a league with no picks at all.
- **Deferred citations.** A recommendation cites the scoring snapshot and forecast that produced it, as
  deferrable foreign keys, so the citation and the thing it cites can be written in one unit of work in
  either order. The scoring citation is composite — `(league_id, scoring_snapshot_id)` — which makes it
  structurally impossible to store points scored under another league's rules.
- **Text with `CHECK` rather than enum types.** Adding a value stays an ordinary migration instead of a
  type alteration that has to be coordinated with running instances.

## Verifying a change

[`verify/`](verify) holds a schema exercise: a realistic dataset, one statement per constraint that
must be refused, and the lease, replacement and retention behaviour. It needs a throwaway database and
nothing else.

```bash
createdb huddle_verify
DATABASE_URL=postgres://localhost/huddle_verify migrations/verify/run.sh
```

It applies every migration, checks the refusals, exercises the functions, rolls every migration back,
and applies them again — so a change that only works on a fresh database fails here rather than in a
deployment.
