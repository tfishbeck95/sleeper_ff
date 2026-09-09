# Huddle

A responsive, read-only fantasy football command center for Sleeper leagues. Huddle combines a polished React dashboard, an authenticated API, scheduled synchronization, a typed Sleeper client, shared business rules, and durable local storage.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:4000` and uses the development bearer token `demo-token`.

## Commands

- `npm run dev` — run the API and web app together.
- `npm run build` — build every workspace.
- `npm test` — run domain, API and web tests.
- `npm run typecheck` — type-check every workspace.

Copy `.env.example` to `.env` to customize local configuration. See [`docs/product-scope.md`](docs/product-scope.md) for product boundaries and [`docs/architecture.md`](docs/architecture.md) for system design.

## Lineup analysis

Forecast providers supply raw projected statistics, plus optional floor and ceiling raw-stat scenarios — never fantasy points. One boundary applies the synchronized league's own scoring rules to every stat line, records the scoring snapshot and forecast timestamp, and refuses any projection whose raw-stat units or player identity cannot be validated instead of defaulting it to zero. Start/sit, matchup totals and win probability, roster strength, replacement levels, bye and playoff outlooks, waiver rankings and trade valuations all consume only those league-scored points. Every figure reads as “18.4 points under your league's full-PPR scoring”, and the statistics that produced it are one click away. Providers can also supply receiving opportunity — targets, targets per route run, route participation, receiving share, red-zone targets and the observed recent target series — which tightens the floor for consistently targeted players, identifies pass-catching backs standard-scoring rankings underrate, separates volume-driven receivers from touchdown-dependent ones, and says in points what your league's reception rule is worth to a trade target. None of it is ever scored twice. See [lineup analysis and the scoring boundary](docs/lineup.md).

## Waiver planning

The Waivers section ranks add/drop pairs by horizon, risk and roster need and builds a copyable priority plan. Claims must be submitted manually in Sleeper. Live rankings require a validated complete Sleeper scoring snapshot and a trusted forecast JSON source configured via `WAIVER_SIGNALS_PATH`; absent or stale forecasts produce an explicit unavailable state. See [waiver pipeline and feed setup](docs/waivers.md) for the contract, scoring assumptions and limitations. Demo scoring is a partial reference and cannot enable actionable rankings.

Kicker streamers require attempts and expected makes in all six distance categories, PATs and validated miss semantics. Their recommendations show expected points, miss downside and workload/context ranking factors. See [kicker adapter and scoring contract](docs/kickers.md).

Team defenses require expected sacks, interceptions, forced fumbles, fumble recoveries, safeties, blocked kicks and defensive touchdowns, plus complete probability distributions over Sleeper's points-allowed and yards-allowed tiers and the unit's special-teams events where your league scores them. Threshold bonuses are priced at their probability rather than granted on a favorable matchup, forced fumbles and recoveries stay separate scoring events, and defensive, team special-teams and individual return touchdowns each map to their own Sleeper rule. Recommendations show expected scoring per component, the major drivers, and ranking factors for opponent pressure, takeaway rates, offensive-line health, starting-quarterback status, game script, shutout and sub-100-yard probability and special-teams opportunity. See [team defense adapter and scoring contract](docs/defense.md).

## Trade planning

The Trades section evaluates every roster and proposes offers only when both managers gain value addressing a need and retain legal lineups within configurable fairness and risk bounds. Redraft and dynasty have separate valuation, with dynasty age, career horizons, rookie capital and contender/rebuilder strategy. Review both teams’ values and lineups, risks and cheaper alternatives, then edit and copy a message. No offers or messages are sent. Live analysis uses the same forecast source with additional dynasty fields; see [trade engine and configuration](docs/trades.md).
