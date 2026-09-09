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

## Waiver planning

The Waivers section ranks add/drop pairs by horizon, risk and roster need and builds a copyable priority plan. Claims must be submitted manually in Sleeper. Live rankings require a trusted forecast JSON source configured via `WAIVER_SIGNALS_PATH`; absent or stale forecasts produce an explicit unavailable state. See [waiver pipeline and feed setup](docs/waivers.md) for the contract, scoring assumptions and limitations. The sample dashboard runs fictional forecasts through the same pipeline.

## Trade planning

The Trades section evaluates every roster and proposes offers only when both managers gain value addressing a need and retain legal lineups within configurable fairness and risk bounds. Redraft and dynasty have separate valuation, with dynasty age, career horizons, rookie capital and contender/rebuilder strategy. Review both teams’ values and lineups, risks and cheaper alternatives, then edit and copy a message. No offers or messages are sent. Live analysis uses the same forecast source with additional dynasty fields; see [trade engine and configuration](docs/trades.md).
