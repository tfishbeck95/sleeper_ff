# Architecture

## Components

```text
Browser (React + shared UI)
        │ authenticated JSON/HTTPS
        ▼
Express API ── recommendation rules (@sleeper/domain)
   │    │
   │    └── league synchronization worker (one instance, leased)
   │              │
   ▼              ▼
repository interfaces    typed Sleeper client
   │                     (documented read API)
   ├── JSON document (local development, one instance)
   └── PostgreSQL schema (apps/api/migrations)
```

`apps/web` renders the responsive dashboard and never contacts Sleeper directly. `apps/api` owns authentication, synchronization, recommendation orchestration, and persistence. `packages/domain` is the dependency-free contract shared by both applications. `packages/sleeper-client` contains the small typed, timeout-bounded upstream adapter. `packages/ui` holds accessible presentation primitives.

## Data flow

1. The browser authenticates to the API and asks for a league dashboard snapshot.
2. The API serves the last successfully persisted snapshot, keeping reads fast and isolating the UI from upstream failures.
3. At process startup and every `SYNC_INTERVAL_MINUTES`, the synchronization worker loads the persisted set of active league connections, resolves each league's season and week, and synchronizes a bounded number of them at a time through the Sleeper client, normalizing the results and atomically replacing the stored snapshot. Each attempt records its outcome, failure category, duration, per-resource freshness and next attempt time on the connection.
4. Manual refresh queues that same job and returns immediately; no HTTP request fans out to Sleeper on the caller's behalf. The UI displays the stored `lastSyncedAt` value and the queued state. See [`docs/league-sync.md`](league-sync.md).
5. Recommendation buttons open analysis or direct users to Sleeper; they never mutate a Sleeper league.

## Storage model

Persistence is behind repository interfaces (`apps/api/src/storage/repositories.ts`), and modules take
the narrowest port they need rather than a store. Every method is one unit of work: an adapter applies
it atomically or not at all, which is what makes `applySync` safe to call with an authoritative
replacement inside it and `rotateSession` safe against a crash between retiring a session id and issuing
its successor. There is no transaction spanning methods, because nothing needs one and offering it would
force the local adapter to pretend to something a file cannot provide.

The local adapter persists a versionable JSON document: snapshots keyed by league ID, the active league
connections with the week each is tracking and the outcome of its last attempt, the shared player
directory, observations, recommendations, the worker's leases and a bounded synchronization log. Writes
use a temporary file followed by an atomic rename, which is atomic within one process and no further.

The PostgreSQL schema in `apps/api/migrations` is the same contract as tables — accounts and sessions,
Sleeper associations, league connections, leagues and their scoring snapshots, members and roster
ownership, players and aliases, rosters and roster history, matchups, transactions, traded picks, weekly
observations, forecast snapshots, recommendations with their explanations and outcomes, synchronization
runs, per-resource freshness and the lease table. Sleeper ids and snapshot ids are keys; a recommendation
cites its league's scoring observation through a composite foreign key, so points scored under one
commissioner's rules cannot rank another league at rest any more than they can in memory; observations
reject `UPDATE`; and retention is SQL functions the worker calls. Session material is digests only, kept
in its own tables and never mixed with public Sleeper ids.

Which adapter a process talks to is explicit configuration, and the JSON adapter is refused for a
multi-instance production deployment rather than warned about. See [`docs/storage.md`](storage.md), and
[`docs/data-durability.md`](data-durability.md) for the backup, restore, rollback and point-in-time
recovery procedures that have to be in place before the first migration that stores user data.

## Deployment model

Build the web application as static assets served through a CDN or the static server in
[`deploy/web.Dockerfile`](../deploy/web.Dockerfile). The API and the worker are two entrypoints over one
composition root and ship as one image: `dist/api.js` serves HTTP and runs no clocks, `dist/worker.js`
owns every schedule and serves no traffic, and `dist/index.js` is both for an installation with a
single instance. Run the API as a single container with a persistent volume for the local profile
(`STORAGE_ADAPTER=json`), or on PostgreSQL for horizontally scaled deployments
(`STORAGE_ADAPTER=postgres`, with `apps/api/migrations` applied by the migration job first).

In scaled production, run the synchronization worker once (`SYNC_WORKER_ENABLED=false` on every API
instance) and implement `SyncLock` over the `sync_lease` table rather than the JSON document: the sweep
lease keeps one instance in charge and the per-league lease keeps a league from being synchronized
twice at once, but the file-backed implementation is only atomic within a process — which is why
`APP_INSTANCE_MODE=multi` refuses the JSON adapter in production. See
[`docs/league-sync.md`](league-sync.md).

Terminate TLS at the edge, restrict CORS to the exact web origins, inject configuration through
environment variables — the process validates all of it before building anything from it and reports
every problem at once — rotate session keys, and expose `/health` to orchestration, which answers 503
from the moment a shutdown begins so a load balancer stops routing before the listener closes. The
forecast subscription key goes to the worker alone, because the worker is the only process that calls
the source. [`docs/deployment.md`](deployment.md) is the full procedure, including which component
holds which secret, the release order, the rollback, and the staging environment.

### Scoring provenance and validation

`League.scoring` is a discriminated snapshot: `complete-live`, `partial-reference`, or
`unavailable`. Both league synchronization and the dashboard metadata endpoint fetch
and persist the selected league's entire `scoring_settings` response. The scoring
observation has its own synchronization timestamp, independent of roster/player
cache timestamps, and is also included in weekly observations. A failed metadata
refresh disables scoring while retaining the last raw observation and recording the
failed attempt time. A later successful, validated response restores availability.

`docs/league-scoring-rules.txt` remains a human-readable partial expected-rules
reference. Its Sleeper key annotations are checked against `EXPECTED_SCORING` by a
test; application code never reads the file. Missing, mismatched, or nonnumeric
values fail validation. Additional numeric Sleeper keys are informational and remain
in the full scoring map, including explicit zero and negative values. No missing
live value is filled from the reference. Intentional documented-rule changes should
update both the reference and the expected-value mapping.

Only `complete-live` snapshots can score forecasts, rank start decisions, evaluate
lineups, or generate waiver/trade recommendations. Legacy flattened settings and
fictional demo configurations are partial references and cannot enable those
engines. Existing stores need a successful synchronization to gain live provenance.
The UI shows the scoring state, observation timestamp, compact summary, and detailed
validation differences; recommendation reports also carry the scoring snapshot used.

### The projection input boundary

Forecast providers supply raw projected statistics plus optional floor and ceiling
raw-stat scenarios. No engine accepts a generic projected-points value. One module,
`apps/api/src/projection-scoring.ts`, applies the synchronized league's own
`ScoringRules` to every raw stat line, computes mean/floor/ceiling points from that
same rule set, stamps each result with the scoring snapshot ID and the forecast
timestamp, and refuses any projection whose raw-stat units or player identity cannot
be validated — including pre-scored keys such as `points` or `projectedPoints`.
Refusals are reported per projection and excluded; they are never zero-filled.

Lineup analysis, start/sit, matchup totals and win probability, roster strength,
replacement levels, bye and playoff outlooks, waiver recommendations and trade
valuations all consume only that output. `LeagueEvaluationService` re-checks each
player's snapshot ID against the league's and fails closed on a mismatch, so points
scored under one commissioner's rules can never rank another league. A source-level
test asserts that no module besides the boundary calls `ScoringRules.score`.

Every scored value carries a manager-facing sentence (`18.4 points under your
league's full-PPR scoring`), the itemized arithmetic, and the ordered scoring
contributions, which the UI discloses on demand. Post-scoring adjustments (bye,
availability window, opponent strength, role trend) are applied separately from the
scoring and listed alongside it. See [`docs/lineup.md`](lineup.md) for the contract.

Providers may also attach receiving opportunity — projected targets, targets per
route run, route participation, receiving share and red-zone targets per week, plus
the observed recent target series per player. `apps/api/src/opportunity.ts` derives
reception-point share, an archetype, pass-catching-back identification, target
stability and the target trend from that workload and from points the league has
already produced. Opportunity is never converted to points: a reception is scored
once, by the league. The only projection it may change is a *supplied* floor
scenario, moved toward its own mean by a bounded, disclosed fraction for a
consistently targeted player; horizon preferences move waiver ranking scores by at
most a documented cap, never projected points.

Kicker and team-defense forecasts extend the same boundary with position-specific
raw contracts rather than exceptions to it. `apps/api/src/defense.ts` validates a
`DEF` unit's expected sacks, interceptions, forced fumbles, fumble recoveries,
safeties, blocked kicks, defensive touchdowns, its team special-teams events where
the league scores them, and a complete probability distribution over Sleeper's
points-allowed and yards-allowed tiers. Each tier's probability is the raw amount the
league's own rate prices, so a shutout bonus is worth the chance of a shutout and the
full bonus is reachable only from a certainty. Forced fumbles and fumble recoveries
stay independent Sleeper events, and `def_td`, `def_st_td` and the individual `st_td`
never collapse into one another. Generic role and matchup multipliers are refused for
both positions: for a defense, a multiplier would scale a probability-weighted
threshold bonus linearly with a matchup opinion. See [`docs/defense.md`](defense.md).

A rostered player's own return scoring is the same boundary again, on the other
side of the same rule split. `apps/api/src/special-teams.ts` validates expected
`st_td`, `st_ff` and `st_fum_rec` counts together with an explicit declaration of
which categories the provider models at all. The two families are refused on each
other's entity as identity failures, and reconciled to one canonical count within an
entity, so a return touchdown is paid to the unit, to the returner, or to both — as
Sleeper does — but never twice to the same fantasy entity. A category the provider
does not model is unknown rather than zero: the league's own rate is read from the
snapshot and reported, nothing is estimated in its place, the projection is marked
as having incomplete coverage, and the gap is named where a designated return role
makes it decision-relevant. Return upside carries a `rankingAdjustment` typed as the
literal `0`, so a speculative return touchdown can never lift a player above one this
league's rules score higher — and the coverage note is recorded after a waiver
candidate's risk grade, so an incomplete feed does not demote the return specialists
it concerns either. See [`docs/special-teams.md`](special-teams.md).

Forecasts reach that boundary either from a hand-maintained file or from the optional provider
adapter in `apps/api/src/providers`. The adapter is upstream of the boundary and subject to it: it
produces raw statistics under Sleeper player ids and never fantasy points. It resolves provider
identities strongest-signal-first and refuses an ambiguous or position-mismatched match rather than
guessing, derives the two fields Sleeper's contracts require and no source publishes while marking
them derived, measures category coverage against the live league's own rules, validates every
candidate with the same `parseWaiverSignals` the file adapter uses, and writes atomically so a
rejected run retains the last good feed and marks it stale rather than replacing it. Coverage,
freshness, identity matching and schema validation have stated service levels that alert on breach.
A commercial source's raw records are licensed for use but not redistribution, so they never reach a
response body. In a scaled deployment its schedule is interval work and belongs on one worker or
behind a distributed lock. See [`docs/projection-provider.md`](projection-provider.md).

Fictional demo view models are isolated from this pipeline by naming: they carry
`illustrativePoints`, never a projection-shaped field, and are never mixed into a
connected league's rankings.
