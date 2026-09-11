# Deployment

How Huddle is built, configured, released and rolled back.

```text
                                  browser
                                     │
                ┌────────────────────┴────────────────────┐
                ▼                                         ▼
        CDN or static server                      load balancer / TLS
        hashed assets: immutable                          │
        index.html: no-cache                              ▼
                                              ┌──────────────────────┐
                                              │    API instances     │  many
                                              │    dist/api.js       │
                                              │ SYNC_WORKER_ENABLED  │
                                              │       = false        │
                                              └──────────┬───────────┘
       ┌─────────────────────┐                           │
       │    migration job    │ ─── runs, exits ──┐       │
       │ apply.sh, then gone │                   │       │
       └─────────────────────┘                   ▼       ▼
       ┌─────────────────────┐  one          ┌──────────────────┐
       │       worker        │ ────────────► │    PostgreSQL    │
       │    dist/worker.js   │               └──────────────────┘
       │ owns every schedule │
       │ holds the forecast  │
       │ subscription key    │
       └─────────────────────┘
```

The dashboard and the API are served from the same site: the session cookie is `__Host-` prefixed and
`SameSite=Strict`, so a cross-site API is never sent it at all.

Three images, built from one commit. The API and the worker are the same image with a different
command, so the worker can never be a release behind the API:

| Image | Built from | Runs | Scales to |
| --- | --- | --- | --- |
| API | [`deploy/api.Dockerfile`](../deploy/api.Dockerfile) | `node dist/api.js` — HTTP only, no clocks | as many instances as traffic needs |
| Worker | the same image | `node dist/worker.js` — every schedule, no HTTP | exactly one |
| Migrations | [`deploy/migrate.Dockerfile`](../deploy/migrate.Dockerfile) | `apply.sh` — applies pending versions and exits | one, before the others start |
| Web | [`deploy/web.Dockerfile`](../deploy/web.Dockerfile) | static bundle behind nginx, or a CDN instead | anywhere |

An installation with a single instance runs `node dist/index.js` instead, which is the API and the
schedule in one process. There is nothing to coordinate, so there is no reason to run two.

## Secrets, and which component holds each one

Every secret below reaches exactly the components listed. The separation is enforced by what the
deployment passes to each process, and [`deploy/compose.yaml`](../deploy/compose.yaml) is the worked
example: the API is never given the forecast key, the worker is never given a web origin, and neither
is given a credential that can alter the schema.

| Secret | Held by | What it is | Without it |
| --- | --- | --- | --- |
| `DATABASE_URL` | api, worker | Connection string, password included. Required by `STORAGE_ADAPTER=postgres`. | Refuses to start. |
| `DATABASE_URL` (migrating role) | migration job only | A separate, higher-privileged role that may alter the schema. The application's own role does not need `CREATE`. | The migration job cannot apply anything. |
| `APP_LOGIN_PASSWORD_HASH` | api | The scrypt hash of the application login. Generate with `npm run password-hash -w @sleeper/api -- 'a-long-unique-password'`; the plaintext is never stored or transmitted anywhere but the sign-in request. | Production refuses to start unless `IDENTITY_PROVIDER` is set. |
| `SPORTSDATAIO_API_KEY` | **worker only** | The licensed projection subscription key. The worker is the only process that calls the source; the API reads the feed the worker retained. | With `PROJECTION_FEED_ENABLED=true`, refuses to start rather than publishing an empty feed. |
| `PROJECTION_FEED_ALERT_WEBHOOK` | worker | Optional operations webhook, an https URL that is itself the credential. | Console alerting only, which is always on. |
| `POSTGRES_PASSWORD` | postgres, and the connection strings built from it | The database role's password. | The stack refuses to start. |

Nothing else is a secret. `WEB_ORIGIN`, `TRUST_PROXY`, the intervals and the service-level thresholds
are policy, and `VITE_API_URL` is compiled into a bundle anyone can read — never put a credential in a
Vite variable. The full non-secret reference is [`.env.example`](../.env.example), and the deployment
values are [`deploy/.env.example`](../deploy/.env.example).

**Rotation.** Each of these is read once at startup, so rotating one is: write the new value, then
restart the components that hold it. The forecast key touches only the worker, so rotating it does not
interrupt the API. Rotating `APP_LOGIN_PASSWORD_HASH` does not end live sessions — they authenticate
against stored session digests, not the password — so follow it with a sign-out everywhere if the old
password is the reason you are rotating.

**Nothing reaches an image.** `.env` and the retained forecast data are excluded from every build
context by [`.dockerignore`](../.dockerignore), and CI asserts it against the built images rather than
against the ignore file, because a file copied into any layer stays in the image even when a later
layer removes it. The forecast feed in particular is licensed for use and not for redistribution, and
an image pushed to a registry is redistribution; it lives on a volume the worker writes.

## Configuration that must be right

The process validates its whole environment before it builds anything from it, and reports every
problem at once rather than one per restart — see `apps/api/src/config/environment.ts`. The ones worth
naming here:

- **`NODE_ENV=production`.** Every production refusal in this application is an exact comparison
  against that string. `prod` or `Production` passes none of them, so it is refused rather than
  treated as production-ish.
- **`STORAGE_ADAPTER`** must name `json` or `postgres`. Production will not guess. The JSON adapter is
  refused outright for a multi-instance deployment: a file is atomic within one process and no
  further, so instances overwrite each other and both take the lease that keeps one worker in charge.
- **`SYNC_WORKER_ENABLED=false` on every API instance.** The sweep lease is the safety net for when
  this is forgotten, not the plan. The value must be exactly `true` or `false`; `no` is refused rather
  than read as `true`, which is what it used to mean.
- **`WEB_ORIGIN`** is the exact origin, https outside local development, and may be a comma-separated
  pair during a cutover. A path is refused: the browser never sends one, so `https://host/app` would
  silently grant the whole host.
- **`TRUST_PROXY`** says what sits in front of the API, and production will not guess. Both ways of
  getting it wrong are silent: too low and every client shares one rate-limit bucket, so the first
  person to exhaust it locks out everybody else; too high and Express reads a value the *client* put
  in `X-Forwarded-For`, so a caller picks their own address, a fresh one per request, and the limits
  stop existing. `TRUST_PROXY=true` is that second case unconditionally — it believes the whole
  chain — and is **refused in production**. The topology above is one hop that rewrites the client
  address, which is why [`deploy/compose.yaml`](../deploy/compose.yaml) sets `TRUST_PROXY: "1"`. An
  API exposed directly is a legitimate deployment and sets `TRUST_PROXY=false`; what production
  refuses is leaving it unset, because an unset value and a correct one look identical until load.
- **`UPSTREAM_*`** are the timeout and retry budgets, defined once in
  `apps/api/src/config/upstream.ts` and applied to both upstream clients. Each is a *whole* budget —
  one attempt's timeout, the attempt count, the backoff ceiling, and the total across all of them —
  because bounding each attempt does not bound their sum. Startup refuses a total shorter than one
  attempt, and warns when the interactive total outlives `SHUTDOWN_GRACE_SECONDS`, which would mean
  a drain cutting a request short rather than finishing it.

## Building and running the whole stack locally

```bash
cd deploy
cp .env.example .env && $EDITOR .env     # POSTGRES_PASSWORD and APP_LOGIN_PASSWORD_HASH have no defaults
docker compose up --build
```

That brings up PostgreSQL, applies the migrations to completion, and then starts the API, the worker
and the dashboard — the deployment topology rather than an approximation of it, because the parts worth
rehearsing are the ones a single all-in-one process hides.

The PostgreSQL adapter is implemented. Apply migrations through 0010 first. The optional
`docker compose --profile single up single` profile still uses one process and a JSON volume.
See [storage constraints](storage.md) and [full-stack tests](testing.md).

## What the API asserts on every response

Applied before routing, so they are on the responses no route handler produces either — the 404 from
the router, the 415 from the body guard, the 429 from a limiter, the 500 from a defect. A header set
inside a route is a header missing from every path that never reaches one.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox` | A JSON API looks like it has no browser surface until something makes a browser parse a response as a document — on this origin, holding the session cookie. The policy and the sandbox make that document inert. |
| `X-Content-Type-Options` | `nosniff` | Stops the guess that turns a JSON body into `text/html` in the first place. |
| `X-Frame-Options` | `DENY` | `frame-ancestors` for browsers that only know the older header. |
| `Referrer-Policy` | `no-referrer` | A URL here can carry a league id; nothing downstream needs it. |
| `Cross-Origin-Resource-Policy` | `same-site` | A response must not become a subresource of another site's page. `same-site`, not `same-origin`, because the dashboard is legitimately a sibling origin. |
| `Cross-Origin-Opener-Policy`, `Origin-Agent-Cluster`, `X-Permitted-Cross-Domain-Policies`, `Permissions-Policy` | isolating defaults | Permissions this origin has never asked for are the easiest ones to keep. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Production only. Asserting it from a development server on plain http teaches the browser to refuse the development server. |
| `X-Request-Id` | the request's id | Echoed on every response and repeated in the body of every failure, so a bug report can name the exact request and an operator can find its line in the log. |

**CORS** is an exact-match list with no permissive fallback: no wildcard, no reflection of the
request's own origin, and no development default in production — an unconfigured production
deployment does not start, and the application cannot be *constructed* with an empty origin list
either. Preflights allow only the methods and headers this API serves, so a request it does not
serve fails at the preflight rather than at the router.

**Cache-control** defaults to `private, no-store` with `Vary: Origin, Cookie`. Almost everything here
is one account's view of one league, and the only thing distinguishing two accounts' requests for
`/api/dashboard/1234` is a cookie. Two deliberate relaxations: `private, no-cache, must-revalidate`
on the player directory and league detail, which are large, slow-changing and revalidate against an
ETag; and `public` on the sample league, which is generated fiction with no account in it and is
refused outright in production.

**Request bodies** are parsed per route at that route's own size, not globally at the largest one —
2kb for a login, 4kb for an account link — with a 16kb ceiling and a content-type check applied
before any of them. A route that takes no body never reads one.

**Failures are classified by what the caller can do about them.** A 4xx says what to fix, in a string
this repository wrote, never echoing the value that was rejected. A 5xx says nothing but its class
and the request id; the message, the stack and the failing path stay in the log. An upstream's 4xx is
not the caller's 4xx: Sleeper answering 400 or 403 means *we* built a bad request, which is a 502.
The exceptions are its 404, which genuinely means the league or user the caller named does not exist,
and its 429, which is a 503 with `Retry-After` because the caller is not over any budget of theirs.

**The probes are three different questions.** `/health/live` asks whether the process can answer at
all; it consults nothing and stays 200 while draining, because a liveness probe that fails during a
graceful shutdown is an orchestrator killing the shutdown it asked for, and one that fails on a
database blip turns one outage into a fleet-wide restart loop. `/health/ready` asks whether to send
this instance traffic; that is where storage and draining belong. `/health` is kept as readiness, so
an existing load balancer configuration does not move. Both are public and say one word plus which
check failed — never the version, the adapter, the worker's identity, an upstream's name or any
path. The internal picture lives behind authentication at `GET /api/ops/status` and on `/metrics`;
see the [runbook](runbook.md).

**Logs are one JSON object per line, redacted on the way out.** Four classes of value never reach one,
and each of them gets there by accident rather than on purpose: session ids and CSRF tokens (and
their digests, which authenticate just as well), the forecast subscription key, absolute filesystem
paths — `ENOENT ... open '/var/lib/huddle/store.json'` is the deployment's layout, published — and
personal settings, where an account appears as a stable digest rather than as a login. `LOG_LEVEL`
sets the floor; `silent` turns a process's own logging off.

## Metrics, probes and alerts

`METRICS_PORT` binds a second listener serving `/metrics`, `/health/live` and `/health/ready`. It is
off unless a port is named, and it is **not** the application port on purpose: a scrape describes the
deployment — route names, traffic volumes, error rates, how many leagues are connected — which is not
a credential and is also not something to hand to whoever asks. Put it on an internal network or a
sidecar rather than behind a token that ends up in a scrape configuration in a repository somewhere.

| Published | Why it is worth having |
| --- | --- |
| Requests, latency and status by **route pattern** | The label is `/api/dashboard/:leagueId`, never the path. Cardinality is fixed by the route table rather than by how many leagues exist. |
| Authentication failures by reason, rate-limit events by budget and dimension | `reuse_detected` rising means a session is being replayed; an `address` scope exhausting is a flood and a `session` scope is one client in a loop. Those need different actions. |
| Sleeper calls, retries, timeouts and failures by endpoint and category | Retries are counted rather than inferred: a call that succeeded on its third attempt is a success *and* two retries, and a graph that only sees the success cannot tell a healthy upstream from one failing two in three. |
| Sync duration, last success, stale and failing leagues | Aggregates, not per-league series. No alert is improved by knowing which of four hundred leagues is oldest; the runbook says how to find it. |
| Forecast age, source timestamp, player count, identity-match rate, coverage | The source timestamp is the only thing that catches a source which stopped publishing while still answering 200. |
| Recommendation readiness and **why** advice was withheld | Refusing to rank is designed behaviour, so the reason is the only operational signal there is. |
| Storage query latency and failures by operation; pool utilization | Timed at the repository seam, so the numbers exist for both JSON and PostgreSQL. The pool series are *absent* rather than zero when there is no pool. |
| Worker sweep lag, queue depth, jobs in flight, lock contention | Lag is what separates "the worker is running" from "the worker is keeping up" — a worker stuck behind a slow upstream answers its probe perfectly. Sweep-lease contention means a second worker is running that `SYNC_WORKER_ENABLED=false` should have opted out. |

The image scan's gate covers OS packages, which each Dockerfile keeps current with `apk upgrade`, and
not binaries vendored into an upstream base image — `gosu` in `postgres:17-alpine` carries Go stdlib
advisories that nothing here builds and `apk` cannot touch. The full report is printed either way; see
the [runbook](runbook.md#vulnerability-scanning-and-what-it-blocks-on).

**Alerting comes in two forms, and you want exactly one of them.** An installation with Prometheus
should scrape `/metrics` and load [`deploy/alerts/huddle.rules.yml`](../deploy/alerts/huddle.rules.yml),
which expresses the conditions with proper windows and `for` durations. An installation without one
gets the built-in evaluator, which runs **on the worker** — the conditions are about the installation,
and evaluating them once per API instance would mean one page per instance for one problem. Six
conditions: stale scoring, stale projections, repeated sync failures, worker inactivity, an elevated
5xx rate, and storage failures. Each carries the anchor of its own section in the
[runbook](runbook.md), because an alert with no action is a notification and notifications train
people to close alerts without reading them.

## The web build

The dashboard is static files with no server side of its own, so it can go to a CDN or behind the
static server in `deploy/web.Dockerfile`. Either way the cache policy is the same, and it is the part
worth getting right:

| Path | Policy | Why |
| --- | --- | --- |
| `/assets/*` | `public, max-age=31536000, immutable` | The filenames carry a content hash, so a given URL's bytes never change. |
| `/index.html` | `no-cache` | It names those files. A visitor holding a cached copy is pinned to the release it was built from, and keeps asking for asset files a later deploy has already removed. |

To a CDN:

```bash
npm run build -w @sleeper/web        # with VITE_API_URL set for the environment being built
aws s3 sync apps/web/dist/assets s3://$BUCKET/assets --cache-control 'public, max-age=31536000, immutable'
aws s3 cp   apps/web/dist/index.html s3://$BUCKET/index.html --cache-control 'no-cache'
```

Upload the assets before `index.html`, so no visitor can load a document naming a file that is not
there yet. Point the distribution's 404 handling at `/index.html` so a route the browser owns renders
rather than 404s, and keep source maps out of the bucket — they are not secret, but they are large and
belong in the error tracker.

**`VITE_API_URL` is a build-time value.** Vite substitutes it into the bundle, so one build serves one
environment: staging and production are separate builds. Leave it empty when the API is reverse-proxied
onto the dashboard's own origin, which is what the `__Host-` prefixed, `SameSite=Strict` session cookie
wants — a cross-site API will not be sent the cookie at all. When the API is on a different host, put
its origin in `API_ORIGIN` too, so the page's `Content-Security-Policy` allows the connection.

## Releasing

One commit produces every image, so the worker can never be a release behind the API and the migrations
are always the ones that release expects.

1. **Build and push** the API, migration and web images, tagged with the commit.
2. **Apply the migrations** and wait for the job to exit 0. It applies only what `schema_migrations`
   says is pending, so a re-run is a no-op, and it holds an advisory lock, so two deployment runners
   that start together do not both apply the same version.
   ```bash
   docker run --rm -e DATABASE_URL="$MIGRATION_DATABASE_URL" huddle-migrate:$COMMIT --dry-run
   docker run --rm -e DATABASE_URL="$MIGRATION_DATABASE_URL" huddle-migrate:$COMMIT
   ```
   Take a backup and a named restore point first — `SELECT pg_create_restore_point('before-$COMMIT')` —
   for anything that drops or rewrites. See [data durability](data-durability.md).
3. **Roll the API instances.** They drain: `/health` answers 503 the moment a `SIGTERM` arrives, the
   listener stops accepting while requests already in flight finish, and the storage handle is closed
   last. Give the orchestrator a termination grace period longer than `SHUTDOWN_GRACE_SECONDS`.
4. **Replace the worker.** One at a time, and never two at once: the old one releases its leases as it
   drains rather than leaving them to expire.
5. **Publish the web build** — assets first, then `index.html`.
6. **Run the staging smoke test** with `npm run test:smoke` and fail deployment verification if it fails. GitHub deployment-status events trigger this automatically; other deployment runners must invoke it explicitly. See [staging credentials and hooks](testing.md#staging-after-deployment).

**Migrations must be safe for both releases at once.** Between steps 2 and 4 the old code is running
against the new schema, and during a rollback the new schema meets the old code again. So anything
destructive goes through expand/contract: add the new shape, deploy code that writes both and reads the
new, backfill, and remove the old shape in a later release once nothing running needs it. Only the last
step is destructive, and by then it is reversible in the only sense that matters.

## Rolling back

**Roll the application back first, and only touch the schema if you have to.** A release is reverted by
deploying the previous images; that is fast, it loses nothing, and an expand/contract migration is
designed to let the previous release run against the newer schema unchanged.

```bash
# 1. Put the previous images back. Nothing else, if the schema is compatible — and it is, if the
#    migration in the bad release was additive.
deploy huddle-api:$PREVIOUS_COMMIT      # API instances, then the worker
publish huddle-web:$PREVIOUS_COMMIT     # assets first, then index.html

# 2. Confirm.
curl -fsS https://api.example.com/health
docker run --rm -e DATABASE_URL="$MIGRATION_DATABASE_URL" huddle-migrate:$PREVIOUS_COMMIT --status
```

Only when the previous release genuinely cannot run against the current schema does the migration come
back too, and then in this order: **stop the worker, roll the application back, roll the schema back,
start the worker.** Rolling the schema back underneath running instances is what turns a bad release
into an outage.

```bash
# Prints what it would roll back and changes nothing. Without --yes it never will.
docker run --rm -e DATABASE_URL="$MIGRATION_DATABASE_URL" \
  --entrypoint /migrations/rollback.sh huddle-migrate:$COMMIT --to 0006
docker run --rm -e DATABASE_URL="$MIGRATION_DATABASE_URL" \
  --entrypoint /migrations/rollback.sh huddle-migrate:$COMMIT --to 0006 --yes
```

Three things to know before running that second command:

- **A down migration is a schema operation, not an undo.** It drops what its up file created, and the
  rows go with it. When the data still matters, recover to the restore point taken before the
  deployment instead — [point-in-time recovery](data-durability.md#point-in-time-recovery) is the
  procedure, and it is the right answer more often than a rollback is.
- **Roll back with the release that applied it.** `rollback.sh` refuses when the ledger names a version
  this checkout has no down file for, because rolling back the versions around it would leave the
  schema in a shape no release has ever run against.
- **Rolling back `0008` stops the mutual exclusion** a multi-instance deployment depends on: the lease
  table is what keeps one worker in charge. Every worker but one must already be stopped.

Rehearse it on staging first. That is what staging is for, and
[`deploy/compose.staging.yaml`](../deploy/compose.staging.yaml) has the command.

## Staging

Staging runs the same images with the same topology and shares nothing with production:

- **Its own database, with its own credentials.** Not a schema inside production's server: a rollback
  rehearsal drops tables, and a connection string that differs only by a search path is one typo away
  from dropping the wrong ones. Separate credentials mean staging's cannot open production's if they
  leak.
- **Its own application login and password hash.** It is the same credential class — the one that opens
  every league the account links — so sharing it makes a staging compromise a production one.
- **Its own league connections.** League connections follow the Sleeper account linked through the
  dashboard and live in that environment's database, so this follows from having a separate database:
  sign in to staging and link a league created for testing. Sleeper is a free shared API and every
  connected league is up to seven calls per sweep, so pointing staging at production's leagues doubles
  the upstream load for a season nobody is playing — and staging runs unreleased synchronization code,
  which is exactly the code that should not be writing the snapshot someone sets a lineup from.
  Staging also sweeps hourly at a concurrency of one.
- **No forecast subscription.** Staging does not spend a licensed quota. It runs with forecasts
  reported unavailable, or on a `WAIVER_SIGNALS_PATH` fixture — both states the dashboard has to render
  correctly anyway.

```bash
cd deploy
cp .env.staging.example .env.staging && $EDITOR .env.staging
docker compose --env-file .env.staging -f compose.yaml -f compose.staging.yaml up --build
```

`COMPOSE_PROJECT_NAME=huddle-staging` is what separates the volumes, the network and the container
names, and the shifted ports let both stacks run on one machine.

## Health, draining and signals

`/health` answers `{"status":"ok"}`, and `503 {"status":"shutting-down"}` from the moment a shutdown
begins — which is how a load balancer learns to stop routing to an instance before its listener closes.
The worker serves the same thing on `WORKER_HEALTH_PORT` when one is named; it binds nothing otherwise,
since it serves no application traffic.

On `SIGTERM` or `SIGINT`, in this order and inside `SHUTDOWN_GRACE_SECONDS`:

1. Everything stops taking new work — the listener closes to new connections, the worker stops
   scheduling sweeps, the ingestion schedule stops, the housekeeping intervals are cleared.
2. Everything already in flight finishes — requests being served, synchronizations part-way through
   replacing a league's authoritative rows, an ingestion seconds from completing. The worker's leases
   are released here rather than left for a replacement instance to wait out.
3. The storage handle closes: the JSON adapter waits for its queued writes to reach the file, and a
   pooled adapter ends its pool.

Past the grace period the process exits anyway and says which step it was waiting on — an orchestrator
that asked a container to stop will kill it regardless, and a shutdown that hangs forever is the
ungraceful one it was meant to replace. A second signal exits immediately.

Set the orchestrator's termination grace period above `SHUTDOWN_GRACE_SECONDS`, or the process will be
killed part-way through its own drain. Compose does this with `stop_grace_period`.

## What refuses to start, and why

A refusal at startup is the point; each of these would otherwise be discovered in production, usually
much later. The process reports every problem it finds at once and exits **78** (`EX_CONFIG`), so an
orchestrator's restart loop is recognizable as a configuration failure rather than a crash.

| Message names | Cause |
| --- | --- |
| `STORAGE_ADAPTER` | Production, and no adapter named. It will not guess. |
| `the JSON adapter cannot back a multi-instance production deployment` | `APP_INSTANCE_MODE=multi` with `STORAGE_ADAPTER=json`. |
| `WEB_ORIGIN` | Unset in production, not https, or an origin with a path. |
| `APP_LOGIN_PASSWORD_HASH is not a scrypt hash` | A plaintext password where the hash belongs. |
| `APP_LOGIN_USER must be lowercase` | Sign-in lowercases the submitted login, so `Admin` would seed an account nothing can sign in to. |
| `SPORTSDATAIO_API_KEY` | The forecast feed is enabled without a credential. |
| `demo authentication cannot be enabled in production` | `ENABLE_DEMO_AUTH=true` with `NODE_ENV=production`. |
| `SYNC_WORKER_ENABLED=false on the worker entrypoint` | A worker container told not to run the schedule, which would leave it healthy and idle forever. |

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request: a clean install
from the lockfile, type checking, tests, a build of every workspace, the migration lint, the schema
applied and rolled back and re-applied against a real PostgreSQL, a secret scan over the history, a
dependency audit that blocks on the production tree, and the three images built and inspected for
anything they should not carry.
