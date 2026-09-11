# Storage

Everything above persistence is written against repository interfaces rather than a store. There are
two adapters behind them: a JSON document for local development, and a PostgreSQL schema for anything
larger. Which one a process talks to is configuration, and a configuration that cannot hold up is
refused at startup rather than discovered later.

- The contract: [`apps/api/src/storage/repositories.ts`](../apps/api/src/storage/repositories.ts)
- The records it moves: [`apps/api/src/storage/records.ts`](../apps/api/src/storage/records.ts)
- The local adapter: [`apps/api/src/store.ts`](../apps/api/src/store.ts)
- The schema: [`apps/api/migrations`](../apps/api/migrations)
- The conformance suite: [`apps/api/src/storage/contract.ts`](../apps/api/src/storage/contract.ts)
- Durability procedures: [data durability](data-durability.md)

## The contract

**Every method is one unit of work.** An adapter applies it atomically or not at all: no reader sees
half of a method's effects, and a crash part-way through leaves the earlier state. That is what makes
`applySync` safe to call with an authoritative replacement inside it, and what makes `rotateSession`
safe — a crash between retiring a session id and issuing its successor would otherwise leave both
usable, or neither.

There is deliberately no `begin`/`commit` spanning methods. Nothing needs one, and offering it would
force the JSON adapter to pretend to something a single file cannot provide. Where several changes must
land together they are one method with one argument: `SyncWrite` carries `replaceDraftPicksForLeague`
rather than a caller issuing a delete and then an insert.

**Authoritative replacement.** Traded picks are the clearest case. A pick that returns to its original
owner disappears from Sleeper's response entirely, so upserting alone would leave it showing its old
owner forever. The league's rows are deleted and reinserted in one transaction, so no reader ever sees a
league with no picks at all — which is a different thing from a league with none, and the difference
changes a dynasty valuation.

**Modules take the narrowest port they need.** Authentication takes accounts and sessions; the lock
takes leases; the worker takes connections, leagues, freshness and leases. Only composition, startup
and the conformance suite take the whole `HuddleRepository`. A unit test supplies a few methods rather
than a store.

## Ports and tables

| Interface | Records | Tables |
| --- | --- | --- |
| `ApplicationUserRepository` | `ApplicationUser` | `app_user` |
| `SessionRepository` | `ApplicationSession` | `app_session`, `app_session_csrf` |
| `SleeperAccountRepository` | `SleeperAccountLink` | `sleeper_account`, `app_user_league` |
| `LeagueConnectionRepository` | `LeagueConnection`, `SyncAttempt` | `league_connection` |
| `LeagueRepository` | `League`, `LeagueScoringSnapshotRecord` | `league`, `league_scoring_snapshot` |
| `PlayerRepository` | `NflPlayer`, `PlayerMetadataState`, `PlayerAlias` | `player`, `player_directory_state`, `player_alias` |
| `RosterRepository` | `Roster`, `RosterObservation` | `roster`, `roster_owner`, `roster_history` |
| `WeeklySnapshotRepository` | `WeeklySnapshot` | `weekly_snapshot`, `weekly_snapshot_matchup` |
| `SnapshotWriteRepository` | `SyncWrite` | `matchup`, `league_transaction`, `transaction_player`, `transaction_draft_pick`, `traded_draft_pick` |
| `ForecastSnapshotRepository` | `ForecastSnapshotRecord` | `forecast_snapshot`, `forecast_player` |
| `RecommendationRepository` | `RecommendationRecord`, `RecommendationExplanation`, `RecommendationOutcome` | `recommendation`, `recommendation_explanation`, `recommendation_outcome` |
| `SyncRunRepository` | `SyncRunRecord` | `sync_run`, `resource_freshness` |
| `LeaseRepository` | `SyncLease` | `sync_lease` |
| `LeagueReadRepository` | the request-scoped read contexts | reads across the above |

A port added without a table fails
[`migrations.test.ts`](../apps/api/src/storage/migrations.test.ts), which keeps the two halves together.

## What the schema enforces

Sleeper's own ids are the keys — one row per league, player, roster slot, matchup, transaction and
traded pick — and snapshot ids are keys too. Three constraints are worth naming, because they are
application rules rather than hygiene:

- **A ranking can only cite its own league's rules.** `recommendation` references
  `league_scoring_snapshot (league_id, id)`, so a record claiming points scored under another
  commissioner's rules cannot be stored. It is the fail-closed check the evaluation service performs in
  memory, expressed at rest.
- **A forecast holds raw statistics, never points.** `forecast_player` rejects `points`,
  `projectedPoints` and their variants inside `stats`, `floor_stats` and `ceiling_stats`. The scoring
  boundary refuses a pre-scored key rather than defaulting it to zero; so does the table.
- **A coverage gap carries no weight.** `recommendation_explanation` rejects a `coverage` row with
  nonzero points. A category a provider does not model may not promote the player it concerns, and may
  not demote one either.

Observations are append-only: weekly snapshots, scoring snapshots, roster history, forecast snapshots
and recommendation outcomes reject `UPDATE` through a trigger. Retention still deletes them. What is
forbidden is quietly rewriting the provenance a ranking cites — a corrected week is a new observation.

Foreign keys constrain the rows this application owns. Sleeper ids that arrive on independent refresh
intervals are indexed but not constrained: rosters refresh every five minutes and the member list every
six hours, so a newly added co-owner legitimately exists on a roster before `sleeper_user` has heard of
them. That is a freshness fact the application already reports, and failing the write would fail the
synchronization that is about to fix it.

Indexes follow the three ways this application reads: by league and week (`matchup`, `roster_history`,
`weekly_snapshot`, `recommendation`), by player (GIN indexes on the roster and matchup id arrays,
`transaction_player`, `forecast_player`, `player_alias`), and by schedule (`league_connection` partial
indexes for what is due and what is prunable).

## Retention

| What | Rule |
| --- | --- |
| Leagues | Archived by the worker when the season can no longer change; deleted only once archived longer than `SYNC_PRUNE_AFTER_DAYS` **and** no account links it |
| Sessions | Dropped once they can no longer authenticate anything, plus a grace window |
| Sync runs | Aged out, keeping each league's most recent attempts however old |
| Forecast snapshots | Aged out, keeping the newest per week and never one a retained recommendation cites |
| Recommendations | Aged out once the advice and every outcome recorded against it are older than the window |
| Roster history | Thinned to the newest observation per roster per week once old enough |
| Player directory | Never touched by league retention: it belongs to every league |

The storage rules are SQL functions (`huddle_apply_retention` and the per-scope functions it calls) and
repository methods on the JSON adapter. The rule about whether a league's season can still change stays
in the worker, where the NFL calendar already lives: duplicating it in SQL would give an installation
two calendars that can disagree. See [league synchronization](league-sync.md#retention).

## Choosing an adapter

| Variable | Values | Meaning |
| --- | --- | --- |
| `STORAGE_ADAPTER` | `json`, `postgres` | Which adapter. Required in production; defaults to `json` outside it |
| `DATABASE_URL` | connection string | Required by `postgres`. A secret: the application logs the database name, never this |
| `APP_INSTANCE_MODE` | `single`, `multi` | How many instances share this storage |
| `DATA_FILE` | path | Where the `json` adapter keeps its document |

Production requires `STORAGE_ADAPTER` to name the adapter. A deployment that silently fell back to a
file because a variable was missing is the failure this refuses, and it is the kind that is only noticed
after two instances have been overwriting each other for a week.

`APP_INSTANCE_MODE` states how many instances there are. When it is unset, one signal is trusted in
production: an instance with `SYNC_WORKER_ENABLED=false` has been told another instance owns the
schedule, which is only true of a fleet. Inferring `multi` from that is deliberately the cautious
direction — it can refuse a single-instance deployment that opted out of its own worker, which is a
misconfiguration worth stopping for, and it cannot let a fleet quietly run on a file.

**The JSON adapter is refused in multi-instance production.** Its writes are atomic within one
process — one queue, one temporary file, one rename — and that is all a file can promise. Two processes
sharing a document interleave between read and rename, so the later write discards the earlier one
silently, and the lease meant to keep one worker in charge of the schedule is taken by both. Outside
production the same configuration is allowed with a warning, because reproducing that failure is
sometimes the point.

## The PostgreSQL adapter

`STORAGE_ADAPTER=postgres` selects `apps/api/src/storage/postgres.ts`. Apply migrations through
0010 before starting either process. The adapter uses the existing normalized tables, including
accounts, session digests, scoring citations and ownership joins; it does not put application state
in a single JSON database row. Both adapters run the same repository conformance cases.

One SQL statement reads a consistent MVCC snapshot. Mutations acquire a transaction-scoped advisory
lock, apply the shared repository rules, and persist only changed rows in foreign-key order. Errors
roll back the complete operation. This first adapter favors correctness for a small installation:
it materializes repository state and serializes mutations across processes, so it is **not a
high-throughput storage implementation**. Measure its memory, query latency and lock contention before
scaling to many accounts; narrower SQL projections and per-entity locking are future optimizations.
Sync history uses explicit retention, without the JSON adapter's global 100-entry cap.

API and worker synchronization share a publication lease, and each snapshot commit verifies that the
publisher still holds it. Metadata, rosters and matchup replacements publish atomically. A lost lease
cannot authorize a late write over a successor. A killed worker's lease expires and its connection
remains eligible for a later sweep. Failed metadata refreshes retain the previous raw rules and weekly
observations while withholding actionable scoring.

Migration 0010 preserves full weekly roster/matchup payloads, backfills old observations, adds the legacy
dashboard snapshot relation, accepts opaque synchronization-run ids, and repairs the scoring-reference
foreign key so deleting a scoring observation never nulls a league's primary key. Its rollback removes
the new payload/table but deliberately retains text sync ids and the corrected foreign-key behavior;
narrowing new ids to UUID would destroy history. Roll the application back before rolling the schema back.
See [full-stack and migration tests](testing.md).
