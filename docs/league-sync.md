# League synchronization

Connected leagues are synchronized by one background worker. The shared player directory has its own
daily refresh interval, described below. League detail reads also fetch Sleeper league resources;
analysis routes perform a synchronization bounded by per-resource TTLs.

The worker lives in [`apps/api/src/scheduler`](../apps/api/src/scheduler). It replaced an interval that
only refreshed the sample league, which meant a connected league was only ever synchronized by whoever
happened to open a page.

## What one sweep does

1. **Reconciles the connection set.** `league_connections` is derived from the leagues the application
   accounts actually link. A newly linked league becomes an active connection; an unlinked one is
   archived, keeping its data. This runs on every sweep, not only at connect time, so a store edited
   elsewhere or restored from a backup converges without an operator.
2. **Applies retention** (below) before filling the queue, so a sweep never spends a slot on a league it
   is about to stop scheduling.
3. **Decides a season and week per league.** The league's own `settings.leg` is authoritative while it
   is playing the season the calendar is in; otherwise the week anchored to the Tuesday of Labor Day
   week is used, and a finished season keeps the week it stopped at. Every path is clamped to weeks 1
   through 18 and can never produce `NaN` — the week is interpolated into an upstream URL, and a wrong
   one silently synchronizes the wrong matchups. The resolved season and week are persisted on the
   connection, so a restart resumes where it left off.
4. **Queues each eligible league** and works the queue with bounded concurrency.
5. **Records the outcome** on the connection: success or failure, the failure category, the duration,
   per-resource freshness, and when the next attempt is due.

Each attempt refreshes the league's metadata and its complete `scoring_settings` before anything else,
because a commissioner can change scoring at any time and every ranking downstream is priced by those
rules. Scoring is never served from a cache interval — see
[architecture](architecture.md#scoring-provenance-and-validation).

## Bounding the load on Sleeper

Sleeper is a free, shared API. Four things keep this application from being the reason it is slow:

- **Bounded concurrency.** At most `SYNC_CONCURRENCY` leagues are in flight at once, however many are
  connected. Each league is up to seven upstream calls, so this is the number that matters.
- **Randomized jitter.** Every attempt waits a random offset up to `SYNC_JITTER_SECONDS` before its
  first call, and each next-attempt time carries its own offset. Without it, a restart turns *N*
  connected leagues into *N* simultaneous bursts, and a fixed interval keeps them aligned forever.
- **Upstream retry guidance.** A `429` or `503` carrying `Retry-After` is honoured exactly: the header
  is parsed in both documented forms and carried on `SleeperApiError.retryAfterMs`. The client waits it
  out only when it fits inside the in-request budget (`maxRetryAfterMs`, 5s); anything longer is handed
  back so the worker can schedule it rather than hold a request open. Without guidance the delay is an
  exponential backoff from `SYNC_RETRY_BASE_SECONDS`, capped at `SYNC_RETRY_MAX_MINUTES`.
- **Per-resource caching.** `REFRESH_AFTER_MS` in [`sync.ts`](../apps/api/src/sync.ts) means a sweep
  usually fetches far less than seven endpoints per league.

## Locks, and running one worker

Two races are covered by one seam, `SyncLock`:

- A **sweep lease** (`league-sync:sweep`) means only one process owns the schedule. Every instance may
  try; one wins and the rest return having done nothing.
- A **per-league lease** (`league-sync:league:<id>`) means one league is never synchronized twice at
  once, by two instances or by a sweep racing a manual refresh. Within a process, jobs for one league
  are additionally serialized, and a second refresh press joins the job already running.

Leases expire rather than being held until a clean release, so an instance killed mid-sweep does not
hold the schedule shut.

`StoreSyncLock` keeps leases in the same JSON store as the data. Within one process this is genuinely
mutually exclusive: the store serializes every write and the read-modify-write that takes a lease
happens inside one of them. **Two processes sharing one JSON file can still interleave**, which is why
the local profile is documented as single-instance. A horizontally scaled deployment implements
`SyncLock` over the database it already runs — `SELECT … FOR UPDATE`, a Postgres advisory lock, or
`SET NX PX` — and nothing above the interface changes. Set `SYNC_WORKER_ENABLED=false` on every
instance except the one worker or managed job; the sweep lease is the safety net for a fleet that
forgets.

## The sample league

The sample league is fiction. It is seeded once at startup when the demo opt-in is on, and it is never
scheduled unless `demoEnabled()` is true — which production refuses, because production does not serve
sample data either. A stored `demo` connection that survives into a production store is skipped with
the reason `demo-disabled` rather than synchronized.

## Retention

Archiving and pruning are different decisions, and both are conservative in the direction that keeps
data:

| | When | What happens |
| --- | --- | --- |
| **Archive** | The league's season is over — an earlier season than the calendar's, or `complete` past week 18 — and its last successful synchronization is older than `SYNC_ARCHIVE_AFTER_DAYS` | It stops being scheduled. Every byte is kept: last season's league is exactly what a manager opens in March. |
| **Prune** | The connection has been archived for longer than `SYNC_PRUNE_AFTER_DAYS` **and** no account links it any more | The league, its rosters, matchups, transactions, traded picks, weekly observations and freshness entries are deleted. The shared player directory is never touched: it belongs to every league. |

A league someone still has connected is never deleted underneath them, however long it has been
archived. Unlinking a league archives it with the reason `unlinked`; re-linking it revives that
connection, while one archived for a finished season stays archived — re-linking a 2024 league is a
request to keep its data, not to start synchronizing a season that cannot change.

## Manual refresh

`POST /api/sync/:leagueId` queues the same job and returns `202` immediately with the queue state and
the last recorded outcome. It does not synchronize the league inside the request: that would mean a
browser waiting on up to seven upstream calls, with as many of those fan-outs in flight as there are
people pressing the button — precisely the load the worker exists to bound. `GET /api/sync/:leagueId`
reports the same state, which is how a client can say *queued*, *running*, *last synchronized at*, or
*waiting until 14:32 because Sleeper rate limited us*.

`?force=true` on the lineup, waiver and trade routes queues a forced refresh the same way; those
requests answer from the last good snapshot rather than waiting for it.

The sample league is the one exception: `POST /api/sync/demo` replaces its snapshot in place and
returns `200`, because there is nothing upstream to queue.

## When Sleeper is unavailable

A failure never removes anything. `lastSyncedAt` and every stored resource survive it; the connection
records the category (`rate_limit`, `timeout`, `network`, `server`, `client`, `validation`, `internal`)
and the next attempt time, and the dashboard keeps serving the last good snapshot with the failure
reported beside it. A metadata refresh that fails additionally marks the league's scoring `unavailable`
while retaining the last raw observation, so no ranking is produced from rules that could not be
confirmed.

## Shared NFL player directory

`PlayerDirectoryService` owns the global `/players/nfl` fetch. The worker checks on startup and hourly;
successful refreshes are spaced at least 24 hours apart. League synchronization and API reads use the
same service, in-flight job, and `players:nfl` lease. A forced league sync cannot override the player
interval. Failures wait at least one hour (or longer if upstream `Retry-After` requires it), with the
next attempt persisted before fetching so restarts also respect the cooldown.
API reads serve an existing directory while a due refresh runs in the background. On a cold start,
they wait at most one second for players, then return placeholders while ingestion continues; a slow
player feed cannot hold league rendering behind its upstream retry budget.

The service validates IDs and consumed field types, rejects empty or malformed feeds, normalizes
names/positions/status fields, and atomically replaces the shared `players` directory and its freshness
in `DATA_FILE`. Responses select from this normalized data without revalidating upstream records.
Failures update attempt/error metadata but never replace the last good players or their successful
timestamp. Successful replacement removes IDs no longer in the feed; those IDs get safe placeholders
when requested. Explicitly retired/deceased entries retain their names and availability flags.

The existing JSON storage profile is persistent and shared across all users and leagues in one API
instance. It is **not a cross-process database**: multiple replicas require a transactional shared
store and distributed player lease, just as the league worker does. Mount `DATA_FILE` on persistent
storage when running in a container.

The browser's `loadLeague` makes one authenticated Huddle request:

- `GET /api/sleeper/leagues/:leagueId?week=8` includes `players` for every roster (including starters,
  IR and taxi), selected-week matchup, and returned transaction add/drop. It never includes unrelated
  free agents or another league's players.
- `GET /api/players/:leagueId` returns the stored league roster subset.
- `GET /api/players/:leagueId?ids=4034,5000` resolves up to 100 explicitly requested IDs, including
  targets from current recommendations. No IDs means no global dump.
- `GET /api/players/:leagueId?q=smith&limit=25` searches names/IDs, with a two-character minimum and
  at most 50 results. IDs and search cannot be combined. All routes require a session linked to the league.

Both responses include `playerMetadata.synchronizedAt` (last successful ingestion, or `null`), `stale`,
`lastAttemptedAt`, `nextAttemptAt`, `lastError`, `unknownPlayerIds`, and `retiredPlayerIds`. Unknown IDs
receive `Player <id>` placeholders with `metadataStatus: "unknown"`; the empty starter sentinel `0`
is excluded. `playerError` explains unavailable, stale, or incomplete coverage without failing league
rendering. The UI displays metadata freshness separately from league freshness.

Responses use `Cache-Control: private, no-cache`, `Vary: Cookie`, and Express content ETags.
Clients may retain a private copy but must revalidate it; unchanged player lookup responses return
`304` for `If-None-Match`. Authentication and league authorization run before conditional responses.
The global refresh interval is deliberately independent of browser caching.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNC_WORKER_ENABLED` | `true` | Whether this process runs the schedule. Set `false` on every instance but the worker. |
| `SYNC_WORKER_ID` | host:pid:random | Lease owner identity. Name it explicitly for a managed job. |
| `SYNC_INTERVAL_MINUTES` | `30` | How often a sweep runs, and the base for a league's next attempt. |
| `SYNC_CONCURRENCY` | `3` | Maximum leagues synchronized at once. |
| `SYNC_JITTER_SECONDS` | `20` | Upper bound on the random offset before each attempt. |
| `SYNC_RETRY_BASE_SECONDS` | `60` | First backoff after a failure with no upstream guidance. |
| `SYNC_RETRY_MAX_MINUTES` | `60` | Cap on that backoff. |
| `SYNC_LEASE_MINUTES` | `10` | Lease TTL. Renewed as a sweep works through its queue. |
| `SYNC_ARCHIVE_AFTER_DAYS` | `30` | Idle window before a finished season stops being scheduled. |
| `SYNC_PRUNE_AFTER_DAYS` | `180` | How long an archived, unlinked league is kept before deletion. |
| `NFL_SEASON`, `NFL_WEEK_ONE_TUESDAY` | derived | Override the calendar season and week-one anchor. |
