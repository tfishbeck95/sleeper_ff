# Operations runbook

What to do when something is wrong, written for the person who has been paged and has not read this
file before.

Every alert this installation can raise has a section below, and every alert carries the anchor to
its own section — in the `runbook` field of a webhook payload, in the log line, and in the
`runbook` label of the Prometheus rules. If an alert reaches you with no section here, that is a bug
in the alert: an alert with no action is a notification, and notifications train people to close
alerts without reading them.

## Before anything else

**Three questions, in this order.** They are cheap, and they change what everything below means.

```bash
# 1. Is the API serving?              (public, no session needed)
curl -fsS https://$API/health/live    # is the process responsive
curl -fsS https://$API/health/ready   # is its storage there, and is it in rotation

# 2. What does the installation think is wrong?   (authenticated)
curl -fsS -b "$COOKIE" https://$API/api/ops/status | jq

# 3. What do the numbers say?         (internal port; never published)
curl -fsS http://$HOST:$METRICS_PORT/metrics | grep -E '^huddle_(league|forecast|worker)'
```

`/api/ops/status` is the one to reach for first. It is a single read that answers all four dependency
questions at once, and its `state` field is the worst of them:

| Field | What it means when it is not `ready` |
| --- | --- |
| `scoring` | Rankings are being refused for some or all leagues. Nothing is broken; nothing is being advised either. |
| `forecast` | The projection feed is stale, degraded, or absent. |
| `leagueSync` | Leagues are not being refreshed. Dashboards are serving old snapshots. |
| `worker` | Nobody is running the schedule. This is the one that looks like uptime. |
| `sleeper` | The upstream API is failing our calls. Usually theirs, occasionally ours. |

**The single most useful thing to know about this system:** every API instance keeps serving the last
good snapshot perfectly while the worker that refreshes it is dead. Uptime is not evidence that
anything is current. `worker` and `leagueSync` are where to look when a user says the data is wrong
but everything is green.

**What to tell a user during any of this.** Rankings are refused rather than estimated when their
inputs are not trustworthy, so the failure mode is missing advice, not wrong advice. Nobody is being
told to start the wrong player.

---

<a id="stale-scoring"></a>
## `stale-scoring` — scoring is unvalidated or stale

**What fired.** One or more active leagues have no validated observation of their own scoring rules,
or the newest observation is older than six hours.

**Why it matters.** Every number this application produces is derived from the league's scoring
rules. Without a validated observation the engines refuse to rank — so the symptom a user reports is
"the recommendations are gone", not an error.

**Diagnose.**

```bash
curl -fsS -b "$COOKIE" https://$API/api/ops/status | jq .scoring
# unavailable > 0  → the observation failed validation
# stale > 0        → it validated, but a while ago
```

Then look at one league's dashboard response: `scoring.issues[]` names exactly which rule failed to
validate, and `scoring.kind` says whether it is `unavailable`, `partial-reference` or live.

**Likely causes, in order.**

1. **Sleeper's league metadata call is failing.** Check `leagueSync` in the same response and the
   `sleeper` error rate. If synchronization is failing, fix that first — scoring is refreshed by it.
2. **A commissioner changed scoring to something we do not model.** `scoring.issues[]` names the
   setting. This is not a fault; it is the system declining to price a rule it does not understand.
3. **The league is complete or archived.** A finished season stops being scheduled. Expected.

**Recover.**

```bash
# Queue a refresh for one league; it returns immediately with the queue position.
curl -fsS -X POST -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
  "https://$API/api/sync/$LEAGUE_ID?force=true"
curl -fsS -b "$COOKIE" "https://$API/api/sync/$LEAGUE_ID" | jq
```

If the observation still fails to validate, the rule is one we do not model: capture
`scoring.issues[]` and raise it as a product issue rather than an incident. **Do not** work around it
by disabling validation — the whole point is that a ranking priced against rules we misread is worse
than no ranking.

---

<a id="stale-projections"></a>
## `stale-projections` — the forecast feed is stale or degraded

**What fired.** One of three things: the retained feed is past its staleness threshold and has
stopped answering; the source's own timestamp has not moved in six hours; or the identity match rate
has fallen below 95%.

**Why it matters.** Past the staleness threshold the feed stops answering and every ranking reports
unavailable. Below the identity threshold it is worse than an outage: unmatched players are silently
absent from rankings rather than reported, so the advice looks complete and is not.

**Diagnose.**

```bash
curl -fsS -b "$COOKIE" https://$API/api/ops/status | jq .forecast
```

`reason` is the field to read:

| `reason` | Meaning | Where to look |
| --- | --- | --- |
| `stale` | Nothing has been ingested recently | The worker. Is it running? Is the credential valid? |
| `identity_match_below_threshold` | The feed arrived; we cannot map its players to Sleeper ids | The nflverse identity map, and roster churn |
| `incomplete_coverage` | A category the leagues score is not supplied | The source's plan or its API changing |
| `no_feed` | No feed has ever been ingested | Expected with no data licence; see below |
| `unmeasured_source` | A `WAIVER_SIGNALS_PATH` fixture is in use | Expected in staging |

**`no_feed` is not necessarily a fault.** An installation with no data licence is supported: rankings
report an explicit unavailable state rather than guessing. If `PROJECTION_FEED_ENABLED` is false,
this alert should not be firing — check `OPS_ALERT_*` configuration rather than the feed.

**Recover.**

1. **Confirm the worker is ingesting.** Ingestion runs on the worker only, on the projection feed's
   own schedule. Check `worker` in the status response first — a dead worker presents as a stale
   forecast, and fixing the worker fixes this.
2. **Check the credential.** A 401 from the source is reported as an ingestion failure and never as
   an authentication message to a user. `SPORTSDATAIO_API_KEY` is held by the **worker only**;
   rotating it means writing the new value and restarting the worker, which does not interrupt the
   API.
3. **Run an ingestion by hand** to see the failure directly:
   ```bash
   npm run ingest -w @sleeper/api -- 2026 8   # season, week
   ```
   It prints a JSON report: `status`, `players`, `identity`, `coverage`, `breaches`.
4. **For a low identity match rate**, the reference identity map has usually gone stale against
   roster cuts. It is refreshed by the same ingestion. If it stays low, the source has changed its
   player identifiers and the adapter needs updating — that is a code change, not an operation.

**The last good feed is always kept.** A rejected ingestion never replaces a good feed with a bad
one, so recovering is always "ingest successfully once", never "restore a backup".

---

<a id="repeated-sync-failures"></a>
## `repeated-sync-failures` — leagues are not refreshing

**What fired.** Leagues have no successful synchronization inside the staleness window, or a league
has failed several attempts in a row.

**Why it matters.** Dashboards keep serving the last good snapshot, so nothing looks broken. A
manager can set a lineup from a roster that is hours out of date.

**Diagnose.**

```bash
curl -fsS -b "$COOKIE" https://$API/api/ops/status | jq '.leagueSync, .sleeper'
# staleLeagues       → how many are behind
# worstFailureStreak → how deep the deepest failure streak is
# sleeper.errorRate  → whether the cause is upstream

# Which league, and why it last failed:
curl -fsS -b "$COOKIE" "https://$API/api/sync/$LEAGUE_ID" | jq
# lastStatus, lastCategory, consecutiveFailures, nextAttemptAt
```

`lastCategory` is the diagnosis:

| Category | Meaning | Action |
| --- | --- | --- |
| `rate_limit` | Sleeper is throttling us | Lower `SYNC_CONCURRENCY`. Do not retry harder. |
| `timeout` / `network` | Sleeper is slow or unreachable | Wait. The backoff is already doing the right thing. |
| `not_found` | The league no longer exists upstream | Expected after a league is deleted; it will be archived. |
| `server` | Sleeper is unwell | Wait, and check their status. |
| `validation` | Sleeper answered with a shape we refuse | A code issue. Capture the league id and raise it. |
| `internal` | A defect here | Check the logs for the request id; this is ours. |

**Recover.**

1. If `sleeper.errorRate` is high, this is upstream. The backoff and `Retry-After` handling are
   already correct; **do not** lower the retry delays or raise concurrency to "catch up". Sleeper is
   a free shared API and the fastest route back to normal is asking it for less, not more.
2. If one league is failing and others are fine, force it:
   ```bash
   curl -fsS -X POST -b "$COOKIE" -H "X-CSRF-Token: $CSRF" \
     "https://$API/api/sync/$LEAGUE_ID?force=true"
   ```
3. If nothing is synchronizing at all, go to [`worker-inactive`](#worker-inactive). This alert is
   frequently a symptom of that one.

---

<a id="worker-inactive"></a>
## `worker-inactive` — nobody is running the schedule

**What fired.** The sweep lease has not been claimed or renewed for longer than two sweep intervals.

**Why it matters.** This is the failure that looks like uptime. Every API instance is healthy, every
dashboard answers, every probe is green — and nothing is being refreshed. It will be reported by a
user before it is noticed by a graph, unless this alert catches it.

**Diagnose.**

```bash
curl -fsS -b "$COOKIE" https://$API/api/ops/status | jq .worker
# held: false and a large ageSeconds → no worker is running
# held: true with a stale heartbeat  → a worker is running and stuck

# Is the worker process up at all?
curl -fsS http://$WORKER_HOST:$WORKER_HEALTH_PORT/health/live
curl -fsS http://$WORKER_HOST:$WORKER_HEALTH_PORT/health/ready
```

**Three distinct situations, which need different things.**

1. **No worker process.** `/health/live` does not answer. Start it. Check its logs for a refusal
   first: the worker exits 78 when `SYNC_WORKER_ENABLED=false`, deliberately, because a worker told
   not to run the schedule would otherwise sit there healthy and idle forever.
2. **The worker is up but not sweeping.** `/health/live` answers, the heartbeat is old. Check
   `huddle_worker_sweep_lag_seconds` and `huddle_worker_queue_depth`: a deep queue with a growing lag
   is a worker stuck behind a slow upstream, not a dead one. Look at `sleeper` in the status response
   before restarting anything — a restart abandons in-flight work and does not fix a slow upstream.
3. **The worker is up and the lease is held by something else.** `huddle_lock_contention_total` with
   `lease="sweep"` is climbing. A second process thinks it owns the schedule: an API instance without
   `SYNC_WORKER_ENABLED=false`, or an old worker that was never stopped. This doubles the load on a
   free shared upstream. Find it and set the flag.

**Recover.** Restart the worker. It takes the lease on startup, sweeps immediately, and catches up.
A killed worker's lease expires on its own (`SYNC_LEASE_MINUTES`); there is nothing to clean up by
hand, and **you should not delete a lease row** to hurry it — that is how two workers end up
synchronizing the same league.

---

<a id="elevated-5xx"></a>
## `elevated-5xx` — requests are failing

**What fired.** More than 5% (warning) or 25% (critical) of requests in the window returned a 5xx.

**Why it matters.** A 5xx here is, by construction, **our** fault. The error classification is
deliberate: an upstream's 4xx becomes a 502 because we built the bad request, and only an upstream
404 or a caller's own bad input produces a 4xx. So a 5xx rate is never "users sending us rubbish".

**Diagnose.** Every failure carries a request id, in the `X-Request-Id` header and in the body. Start
from one:

```bash
# Which routes, and which status classes:
curl -fsS http://$HOST:$METRICS_PORT/metrics | grep huddle_http_requests_total

# Then find the line: every failure logs once, at error level, with the request id.
# The log carries the message, the stack and the failing path; the response carries none of them.
```

The `code` field in the response body separates the classes without reading a log:

| `code` | Meaning |
| --- | --- |
| `upstream_unavailable` / `upstream_timeout` | Sleeper. Go to [`repeated-sync-failures`](#repeated-sync-failures). |
| `upstream_failed` | We built a bad request, **or** a provider credential is wrong. Check the logs. |
| `internal` | A defect. The log line has the stack. |

**Recover.** If it is `upstream_*`, this is usually not a deploy and not actionable beyond waiting —
check Sleeper's status. If it is `internal` and started at a deploy, roll back: the images are tagged
with the commit, and a rollback is redeploying the previous tag. Migrations are applied separately
and are not rolled back by a code rollback; see [deployment](deployment.md#releasing).

---

<a id="storage-failures"></a>
## `storage-failures` — the repository is failing

**What fired.** Repository operations are throwing, or p99 latency has gone past a second.

**Why it matters.** This is distinct from the readiness probe, which asks whether storage answers at
all. A store that answers a probe while failing real operations is the shape a dying disk, a full
volume or an exhausted connection pool takes — and readiness will stay green throughout.

**Diagnose.**

```bash
curl -fsS http://$HOST:$METRICS_PORT/metrics \
  | grep -E 'huddle_storage_(failures_total|query_duration_seconds_count|pool_connections)'
```

`huddle_storage_failures_total` is labelled by operation. The operation name says which subsystem:
`saveSession`/`session` is authentication, `applySync` is synchronization, `playerDirectory` is the
shared directory.

**By adapter.**

- **JSON adapter.** Almost always the disk: full, read-only, or a volume that was not mounted. Check
  free space first — `applySync` writes the whole document. The adapter writes to a temporary file
  and renames, so a partial write is not a corrupted store; a failure is a failure to write at all.
- **PostgreSQL adapter.** Check `huddle_storage_pool_connections`. A `waiting` count above zero with
  `idle` at zero is pool exhaustion: something is holding connections, usually a slow query rather
  than a leak. These series are **absent** for the JSON adapter, which has no pool — absent, rather
  than zero, so a dashboard cannot render "no pool" as "a healthy pool".

**Recover.** Storage failures are infrastructure, not application state. Free space, fix the mount,
or raise the pool. Nothing in this application needs repairing afterwards: writes are atomic within
one process for the JSON adapter and transactional for PostgreSQL, and a failed write is a write that
did not happen.

**Before you restart anything:** the process holds no state worth preserving except in-flight
synchronizations, and those are safe to abandon — a sweep that dies mid-way leaves its lease to
expire and the next sweep redoes it.

---

<a id="session-reuse"></a>
## `session-reuse` — a retired session id was replayed

**What fired.** A session id that had already been rotated out was presented after its grace window.

**Why it matters.** This is the only alert here that means a credential is in somebody else's hands
rather than that something is slow. Past the rotation grace window a retired id can only be a copy:
the legitimate client was issued a replacement and has been using it.

**What already happened automatically.** The whole session family was revoked. The person holding the
real session and the person holding the copy have both been signed out. No action is required to
contain it.

**Diagnose.** The account is in the log line as a digest (`account`), not as a login — deliberately.
To identify it you need the digest and the account list; that is an access-controlled action, not a
grep.

**Recover.** If this is a single event, it is most often a client restoring a suspended browser
session or a badly behaved network appliance replaying a request. If it repeats for one account:
revoke everything for that account and have them sign in again.

```bash
# Signing out everywhere revokes every session belonging to the user.
curl -fsS -X POST -b "$COOKIE" -H "X-CSRF-Token: $CSRF" https://$API/auth/logout-all
```

Rotating `APP_LOGIN_PASSWORD_HASH` does **not** end live sessions — they authenticate against stored
session digests, not the password — so a password rotation must be followed by a sign-out everywhere
if the old password is the reason you are rotating.

---

## Things that look like incidents and are not

- **Rankings reporting "unavailable".** The engines refuse to rank when scoring or forecasts are not
  trustworthy. This is the designed behaviour and it is safer than the alternative. Find out *why*
  from `/api/ops/status`; do not look for a way to make them rank anyway.
- **A single failed synchronization.** Sleeper is a free shared API. The backoff exists so one failure
  does not need a person.
- **429s in the access log.** The rate limits working. Check `huddle_rate_limit_events_total` — an
  `address` scope climbing is a flood, a `session` scope climbing is one client in a loop.
- **A 503 from `/health/ready` during a deploy.** That is a draining instance leaving the rotation,
  which is the entire point of the readiness/liveness split. `/health/live` stays 200 throughout.
- **`no_feed` on an installation with no data licence.** Supported configuration.

## Where the numbers come from

| Question | Where |
| --- | --- |
| Is it up? | `/health/live` — public, says one word |
| Should it get traffic? | `/health/ready` — public, says one word and which check failed |
| What is degraded? | `GET /api/ops/status` — **authenticated** |
| The numbers | `/metrics` on `METRICS_PORT` — **internal network only** |
| Alert definitions | [`deploy/alerts/huddle.rules.yml`](../deploy/alerts/huddle.rules.yml), and `apps/api/src/observability/alerts.ts` for the built-in evaluator |

`/metrics` is not on the application port and must not be published. It describes the deployment —
route names, traffic volumes, error rates, how many leagues are connected — which is not a credential
and is not something to hand to whoever asks.
