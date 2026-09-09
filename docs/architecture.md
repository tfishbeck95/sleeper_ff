# Architecture

## Components

```text
Browser (React + shared UI)
        │ authenticated JSON/HTTPS
        ▼
Express API ── recommendation rules (@sleeper/domain)
   │    │
   │    └── scheduler (startup + configurable interval)
   │              │
   ▼              ▼
JSON snapshot store     typed Sleeper client
(durable volume)        (documented read API)
```

`apps/web` renders the responsive dashboard and never contacts Sleeper directly. `apps/api` owns authentication, synchronization, recommendation orchestration, and persistence. `packages/domain` is the dependency-free contract shared by both applications. `packages/sleeper-client` contains the small typed, timeout-bounded upstream adapter. `packages/ui` holds accessible presentation primitives.

## Data flow

1. The browser authenticates to the API and asks for a league dashboard snapshot.
2. The API serves the last successfully persisted snapshot, keeping reads fast and isolating the UI from upstream failures.
3. At process startup and every `SYNC_INTERVAL_MINUTES`, the scheduler requests supported public data through the Sleeper client, normalizes it, evaluates domain rules, and atomically replaces the stored snapshot.
4. Manual refresh queues the same idempotent synchronization path. The UI displays the stored `lastSyncedAt` value.
5. Recommendation buttons open analysis or direct users to Sleeper; they never mutate a Sleeper league.

## Storage model

The local adapter persists a versionable JSON document containing snapshots keyed by league ID and a bounded synchronization log. Writes use a temporary file followed by an atomic rename. Production deployments should implement the same repository interface with PostgreSQL: `users`, `league_connections`, `league_snapshots`, `recommendations`, and `sync_runs`. Encrypt any session material at rest and keep it separate from public Sleeper IDs.

## Deployment model

Build the web application as static assets served through a CDN. Run the API as a single container with a persistent volume for the local profile or PostgreSQL for horizontally scaled deployments. In scaled production, move interval work to one dedicated worker or managed cron job and use a distributed lock. Terminate TLS at the edge, restrict CORS to the web origin, inject configuration through environment variables, rotate bearer/session keys, and expose `/health` to orchestration.

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

Fictional demo view models are isolated from this pipeline by naming: they carry
`illustrativePoints`, never a projection-shaped field, and are never mixed into a
connected league's rankings.
