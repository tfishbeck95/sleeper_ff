# Full-stack verification

Run `npm ci`, `npx playwright install chromium`, then `npm run test:e2e`.
The command builds every workspace, starts an isolated PostgreSQL 17 container, checks recorded
Sleeper contracts, runs the PostgreSQL repository and upgrade suite, and launches Playwright.
On Linux, install browser system dependencies with `npx playwright install --with-deps chromium`.
Node 22, OpenSSL and a running Docker-compatible engine are required. For Podman, use
`CONTAINER_ENGINE=podman npm run test:e2e`. Docker honors its usual `DOCKER_CONTEXT` setting.
The runner never changes the machine's default container context.

Each browser scenario creates its own randomly named database, applies the release's migrations,
and launches the **compiled** API (`dist/api.js`) and worker (`dist/worker.js`) as separate processes.
Both use `NODE_ENV=production`, the PostgreSQL adapter, and the real session, CSRF, retry and scoring
code. A local HTTPS server serves the compiled Vite bundle and proxies API requests on the same origin.
A short-lived self-signed certificate permits secure `__Host-` cookies; only the test browser trusts it.
The worker receives no login password hash or browser origin. The harness never loads `.env`.

A controllable HTTP server substitutes for Sleeper through `SLEEPER_API_BASE_URL`. Unconfigured
fixture routes fail; they never fall through to the internet. Its gates, counters and failure queues
live in the test process, with no administration endpoints added to the application. Forecast files
are synthetic and written atomically. No commercial provider key is needed or consumed.

To use an existing **isolated test server**, supply `E2E_DATABASE_URL` and run `npm run test:e2e`.
Its role needs `CREATEDB`: tests create and drop their own random databases, never reset the database
named in that URL. The runner removes its own container on completion or signals; a supplied server
is left running. Processes, fixture files and per-test databases are cleaned up on failures too.
Playwright keeps failure screenshots, videos, traces, sanitized service logs, HTML and JUnit reports
under `test-results/` and `playwright-report/`. CI retains them for seven days.

## Scenario coverage

| Requirement | Executable checks |
| --- | --- |
| Sign in/out | Browser password failure/success, secure cookie policy, reload, logout and replay refusal |
| Username resolution | Successful and missing users, invalid syntax; browser trims surrounding whitespace |
| Seasons/leagues | Three seasons, several leagues, saved selection and switching command-center reads |
| Owner/co-owner | Both identities resolve to roster 1; a separate application account is denied access |
| Complete live scoring | Exact live rule map, populated lineup and waiver results, scoring provenance |
| Mismatched/unavailable scoring | Differences disclosed; all three recommendation engines withhold rankings |
| League configurations | Standard, PPR, dynasty, keeper, superflex, kicker and D/ST slot/rule interpretation |
| Forecast states | Fresh, stale, missing, malformed and partial coverage, preserving roster information |
| Sleeper failures | Actual timeout/abort, 429 with Retry-After, 404 without retry, temporary 503 then recovery |
| Refresh races | A blocked worker and manual requests in the API share leases; remote progress is visible |
| One snapshot | All sections and engine results cite one scoring and forecast observation |
| Mobile/accessibility | 375px and 390px layouts, no viewport overflow, keyboard focus, axe WCAG A/AA checks |
| Authorization | Other sessions cannot read dashboard, player, league, sync, lineup, waiver or trade data; CSRF enforced |
| Migration | Frozen schema 0009 plus populated identity, sessions, ownership, snapshots and citations upgraded twice |
| Recovery | API/worker SIGKILL, session and last-good-week survival, worker killed mid-publication, expired lease recovery |
| Deployment | The same smoke harness exercised against the compiled production-mode test stack |

The standard-scoring scenario intentionally asserts the application's existing fail-closed behavior:
a zero reception rate differs from its documented PPR scoring contract. It must remain visible as zero
and disable advice, rather than silently switching to PPR. These tests do not add support for scoring
formats the product currently rejects. Keeper trade valuation likewise retains its existing limits.

Unit and component tests remain `npm test`; `npm run typecheck` checks all workspaces.
`npm run test:contracts` runs recorded contracts after a build, and `npm run test:postgres` runs database
checks with `E2E_DATABASE_URL`. Passing `-- --grep 'mobile'` to `npm run test:e2e` filters browser tests
while retaining build, contract and database prerequisites. Full-stack CI has no skipped or expected-failure
scenarios and no automatic retries that could hide intermittent races.

## Recorded Sleeper contracts

`tests/fixtures/sleeper/manifest.json` records capture time, templated endpoint, source host and a SHA-256
for each response. These ten fixtures were recorded over real HTTP from Sleeper's public documented
example league. The NFL directory is a public player subset. They exercise the compiled Sleeper client
and player normalizer; synthetic scenarios provide controlled scoring and failure variants separately.

Run `npm run fixtures:record` to refresh. To capture an authorized test league, supply
`SLEEPER_FIXTURE_LEAGUE_ID` and optionally `SLEEPER_FIXTURE_WEEK` through the environment. The recorder
never writes a raw response or reversible mapping, and never prints the original request URL.
It uses explicit field allowlists, consistent synthetic user/league/draft/transaction IDs, synthetic
account/league names, null avatars, and removes arbitrary metadata and contact information. Account
joins survive sanitization. The test checks fixture digests and privacy invariants. Review fixture diffs
before committing. Normal CI never contacts Sleeper or refreshes recordings automatically.

## Previous-schema baseline

`tests/fixtures/schema-0009/` freezes the pre-change repository schema from commit
`f4801927ec37773ec59b86344b6ff002e4fc5779`. The synthetic dataset covers a saved connection, session,
co-owner, weekly snapshot, forecast, recommendation, explanation and outcome. The baseline is independent
of current migration files, so editing an old migration cannot silently change the upgrade input.
Schema 0009 is the assumed previous-production baseline; confirm it against the actual release before
using this as evidence for a different production schema. On a later release, replace the frozen baseline
with the previous deployed schema and review the dataset and expected latest migration together.

## Staging after deployment

`.github/workflows/staging-smoke.yml` runs after **every successful GitHub deployment status**, with no
cancellation of earlier deployment runs. It always targets the configured staging origin. It can also
be invoked manually or as a reusable workflow. A deployment system that does not emit GitHub deployment
statuses must call `npm run test:smoke` as its final step and propagate a nonzero exit status as deployment
verification failure. This repository has no provider-specific deploy workflow to hook otherwise.

Configure the GitHub `staging` environment with:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `STAGING_BASE_URL` | HTTPS staging origin, without a path |
| Variable | `STAGING_SMOKE_WEEK` | Week 1–18 for the dedicated league |
| Secret | `STAGING_SMOKE_LOGIN` | Dedicated application account |
| Secret | `STAGING_SMOKE_PASSWORD` | Its password |
| Secret | `STAGING_SMOKE_LEAGUE_ID` | Dedicated league already linked to that account |

The smoke test checks both health probes, the compiled browser, sign-in, secure cookie attributes,
session restoration, the saved league, recommendation provenance and sign-out. It permits explicit
unavailable forecasts, since staging need not have a paid feed, but fails on engine errors. It does not
link accounts, reset storage or submit transactions to Sleeper. Live smoke runs retain no traces or
screenshots with staging account data and emit no response bodies or credentials. The smoke script itself
has been exercised locally; an actual staging run requires these environment settings and a deployment.
