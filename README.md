# Huddle

A responsive, read-only fantasy football command center for Sleeper leagues. Huddle combines a polished React dashboard, an authenticated API, scheduled synchronization, a typed Sleeper client, shared business rules, and durable local storage.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Configure an application login first; session cookies require HTTPS, or `INSECURE_DEV_COOKIES=true` on a development machine without it. Sessions expire, rotate and can be revoked, mutating requests carry a CSRF token, and league access is derived from the session rather than the request. Demo authentication and every sample-league response are a separate, explicit development-only opt-in that production refuses to serve. See [`docs/identity-and-sessions.md`](docs/identity-and-sessions.md).

## Commands

- `npm run dev` — run the API and web app together.
- `npm run build` — build every workspace.
- `npm test` — run domain, API and web tests.
- `npm run typecheck` — type-check every workspace.

Copy `.env.example` to `.env` to customize local configuration. Every value in it is validated before
anything is built from it, and every problem is reported at once rather than one per restart. See
[`docs/product-scope.md`](docs/product-scope.md) for product boundaries and
[`docs/architecture.md`](docs/architecture.md) for system design.

## Deployment

Three images built from one commit: the API and the worker share one, the migrations are their own, and
the dashboard is a static bundle for a CDN or the static server beside it. The API serves HTTP and runs
no clocks; one worker owns every schedule and is the only process holding the forecast subscription
key; a migration job applies the pending schema versions and exits before either starts. Stopping any
of them drains — requests already being served finish, a synchronization part-way through replacing a
league's rows is not abandoned, and leases are released rather than left to expire.

```bash
cd deploy && cp .env.example .env && $EDITOR .env
docker compose up --build              # PostgreSQL, migrations, API, worker, dashboard
docker compose --profile single up single   # or: one process, JSON adapter, one volume
```

[`docs/deployment.md`](docs/deployment.md) is the full procedure: which component holds which secret,
the CDN cache policy, the release order, the rollback, and the staging environment — separate database,
separate credentials, separate league connections.

## Operating it

`/health/live` asks whether the process can answer; `/health/ready` asks whether to send it traffic.
They are separate because a liveness probe that fails on a database blip turns one outage into a
fleet-wide restart loop, and one that fails during a drain kills the shutdown it was asked to
perform. Both are public and say one word. The internal picture — forecast freshness, the last
successful league synchronization, whether anything is claiming the schedule, how Sleeper is
behaving — is authenticated at `GET /api/ops/status`, and the numbers behind it are on `/metrics`,
served on its own internal port rather than the application's.

Six conditions raise an alert: stale scoring, stale projections, repeated sync failures, worker
inactivity, an elevated 5xx rate, and storage failures. Each names the step that resolves it in
[`docs/runbook.md`](docs/runbook.md), which is written for the person who has been paged and has not
read it before. The failure worth knowing about in advance is the quiet one: every API instance keeps
serving the last good snapshot perfectly while the worker that refreshes it is dead, so uptime is not
evidence that anything is current.

## Storage

Persistence sits behind repository interfaces, with two adapters: a JSON document for local
development, and the PostgreSQL schema in [`apps/api/migrations`](apps/api/migrations) for anything
larger. Which one a process talks to is explicit configuration — `STORAGE_ADAPTER` has to name it in
production, and the JSON adapter is refused for a multi-instance production deployment rather than
warned about, because a file is atomic only within one process: instances overwrite each other and both
take the lease that is supposed to keep one worker in charge of the schedule.

Every repository method is one unit of work, so an authoritative replacement lands whole — a traded pick
that returns to its original owner disappears from Sleeper's response entirely, and the league's
transfers are deleted and reinserted together rather than leaving it showing its old owner forever.
Sleeper ids and snapshot ids are keys, observations are append-only, a recommendation cites the scoring
observation and forecast that produced it through foreign keys that make citing another league's rules
impossible to store, and retention deletes a league's data only once it has been archived and no account
links it. See [storage](docs/storage.md).

The procedures for backup, restore, migration rollback and point-in-time recovery are in
[data durability](docs/data-durability.md). They are a precondition rather than an operational nicety:
accounts, sessions, weekly and roster history, forecasts and the advice given under them exist only in
this database, and the first migration is the one that starts storing them.

## League synchronization

Connected leagues are synchronized by one background worker rather than by whoever happens to open a
page. It keeps the set of active league connections and the NFL week each one is tracking, resolves
that week from the league's own settings before falling back to the season calendar, and synchronizes a
bounded number of leagues at a time so a large installation does not lean on a free shared API. Each
attempt refreshes the league's full scoring settings — a commissioner can change them at any time —
and records what it did: success or failure category, duration, per-resource freshness, and when the
next attempt is due. Upstream's own `Retry-After` decides that time when Sleeper sends one; otherwise a
capped exponential backoff does. A failure removes nothing, so the dashboard keeps serving the last good
snapshot with the reason it is not newer. Leagues whose seasons are over stop being scheduled after a
retention window and keep their data; data is deleted only from an archived league no account links any
more. In a multi-instance deployment one worker or managed job owns the schedule, and leases enforce
that. Manual refresh queues the same job instead of fanning out upstream inside the request. See
[league synchronization, locking and retention](docs/league-sync.md).

## Lineup analysis

Forecast providers supply raw projected statistics, plus optional floor and ceiling raw-stat scenarios — never fantasy points. One boundary applies the synchronized league's own scoring rules to every stat line, records the scoring snapshot and forecast timestamp, and refuses any projection whose raw-stat units or player identity cannot be validated instead of defaulting it to zero. Start/sit, matchup totals and win probability, roster strength, replacement levels, bye and playoff outlooks, waiver rankings and trade valuations all consume only those league-scored points. Every figure reads as “18.4 points under your league's full-PPR scoring”, and the statistics that produced it are one click away. Providers can also supply receiving opportunity — targets, targets per route run, route participation, receiving share, red-zone targets and the observed recent target series — which tightens the floor for consistently targeted players, identifies pass-catching backs standard-scoring rankings underrate, separates volume-driven receivers from touchdown-dependent ones, and says in points what your league's reception rule is worth to a trade target. None of it is ever scored twice. See [lineup analysis and the scoring boundary](docs/lineup.md).

## Waiver planning

The Waivers section ranks add/drop pairs by horizon, risk and roster need and builds a copyable priority plan. Claims must be submitted manually in Sleeper. Live rankings require a validated complete Sleeper scoring snapshot and a trusted forecast JSON source configured via `WAIVER_SIGNALS_PATH`; absent or stale forecasts produce an explicit unavailable state. See [waiver pipeline and feed setup](docs/waivers.md) for the contract, scoring assumptions and limitations. Demo scoring is a partial reference and cannot enable actionable rankings.

Kicker streamers require attempts and expected makes in all six distance categories, PATs and validated miss semantics. Their recommendations show expected points, miss downside and workload/context ranking factors. See [kicker adapter and scoring contract](docs/kickers.md).

Team defenses require expected sacks, interceptions, forced fumbles, fumble recoveries, safeties, blocked kicks and defensive touchdowns, plus complete probability distributions over Sleeper's points-allowed and yards-allowed tiers and the unit's special-teams events where your league scores them. Threshold bonuses are priced at their probability rather than granted on a favorable matchup, forced fumbles and recoveries stay separate scoring events, and defensive, team special-teams and individual return touchdowns each map to their own Sleeper rule. Recommendations show expected scoring per component, the major drivers, and ranking factors for opponent pressure, takeaway rates, offensive-line health, starting-quarterback status, game script, shutout and sub-100-yard probability and special-teams opportunity. See [team defense adapter and scoring contract](docs/defense.md).

Individual return production is a separate contract from the team unit's, because Sleeper pays the two families at different rates: `st_td`/`st_ff`/`st_fum_rec` pay a rostered returner, `def_st_td`/`def_st_ff`/`def_st_fum_rec` pay the D/ST, and carrying either family on the other entity is refused. A provider supplies expected counts together with an explicit declaration of which categories it models at all. A category it does not model is treated as unknown rather than zero: it contributes no points and no invented return-touchdown bonus, your league's own rate for it is read from the live snapshot and shown, and the projection is marked as having incomplete special-teams coverage. That gap is named where a designated return role makes it decision-relevant, and it adds exactly zero to every ranking — a return touchdown nobody projected never promotes a lower-scoring return specialist, and never demotes one either. See [individual special-teams contract](docs/special-teams.md).

## Projection and injury feed

Forecasts can be maintained by hand in a JSON file, or ingested automatically from licensed sources. The optional provider adapter fetches weekly raw-stat projections, team-defense projections and injury reports from a commercial source under a licence that permits this use, bridges them onto Sleeper player IDs through an openly licensed identity map, and reports every provider row it could not resolve rather than dropping it. Sleeper requires two things no source publishes — separate 50-59 and 60+ field-goal bands, and probability distributions over the points- and yards-allowed tiers — so the adapter derives them from empirical distributions and records them as derived rather than passing modelling off as source data. Category coverage is measured against the live league's own rules, and anything the league scores but the feed omits is recorded rather than filled or assumed zero. The validated feed is written atomically; a failed or invalid ingestion keeps the last good feed and marks it stale past a configured threshold instead of replacing it. Coverage, freshness, identity matching and schema validation each have a stated service level that alerts when missed. Ingestion runs before the weekly waiver window, after each injury report, and every fifteen minutes on Sundays. It is off unless configured. See [provider adapter, licensing and recovery](docs/projection-provider.md).

## Trade planning

The Trades section evaluates every roster and proposes offers only when both managers gain value addressing a need and retain legal lineups within configurable fairness and risk bounds. Redraft and dynasty have separate valuation, with dynasty age, career horizons, rookie capital and contender/rebuilder strategy. Review both teams’ values and lineups, risks and cheaper alternatives, then edit and copy a message. No offers or messages are sent. Live analysis uses the same forecast source with additional dynasty fields; see [trade engine and configuration](docs/trades.md).

See [Owner command center](docs/command-center.md) for the aggregated dashboard API, shared snapshot provenance, and section readiness states.

## Full-stack tests and staging smoke

Run `npm ci`, `npx playwright install chromium`, and `npm run test:e2e` with Docker running.
The suite builds and launches the HTTPS web app, API and worker against isolated PostgreSQL databases,
replays sanitized Sleeper contracts, and tests migration from schema 0009. See [testing](docs/testing.md)
for all scenarios, Podman/existing database options, artifacts, and the staging secrets needed by the
automatic post-deployment smoke workflow.
