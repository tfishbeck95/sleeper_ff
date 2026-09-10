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

Copy `.env.example` to `.env` to customize local configuration. See [`docs/product-scope.md`](docs/product-scope.md) for product boundaries and [`docs/architecture.md`](docs/architecture.md) for system design.

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
