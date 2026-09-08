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
