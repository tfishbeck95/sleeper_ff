import { LATENCY_BUCKETS, registry, type Labels } from './metrics.js';

/**
 * Every number this application publishes, defined in one place.
 *
 * They are together rather than next to the code that increments them so that the whole surface can
 * be read at once — which is what makes a label's cardinality reviewable, and what stops the same
 * quantity being counted twice under two names.
 *
 * Three rules the definitions follow:
 *
 * - **Labels come from closed sets.** A route pattern, an error category, a status code, a section
 *   name. Never a league id, a path, a username or an error message: those are unbounded, and an
 *   unbounded label is a map that grows with traffic.
 * - **Durations are seconds** and histograms, never milliseconds and never averages. An average
 *   latency is the one number that cannot tell you about the request that was slow.
 * - **A timestamp is a gauge of Unix seconds**, not an age. Ages computed at scrape time are correct
 *   whenever they are read; an age written at collection time is wrong the moment it is written.
 */

const seconds = (at: string | null | undefined): number => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
};

// --- HTTP ---------------------------------------------------------------------------------------

export const httpRequests = registry.counter(
  'huddle_http_requests_total',
  'Requests served, by route pattern, method and status class.',
  ['route', 'method', 'status'],
);
export const httpDuration = registry.histogram(
  'huddle_http_request_duration_seconds',
  'Time to serve a request, by route pattern and method.',
  ['route', 'method'],
);
export const httpInFlight = registry.gauge(
  'huddle_http_requests_in_flight',
  'Requests currently being served.',
);

// --- Authentication and rate limiting -------------------------------------------------------------

/**
 * Why a request failed to authenticate, as a closed set of reasons.
 *
 * Separated from the 401 count because they mean different things to an operator: `invalid_password`
 * rising is somebody guessing, `expired` rising is a session policy that is too short, and
 * `reuse_detected` rising is a stolen cookie being replayed — which is the one worth waking up for.
 */
export const authFailures = registry.counter(
  'huddle_auth_failures_total',
  'Failed authentication attempts, by reason.',
  ['reason'],
);
export const rateLimitEvents = registry.counter(
  'huddle_rate_limit_events_total',
  'Requests refused by a rate limit, by budget and by which dimension was exhausted.',
  ['bucket', 'scope'],
);

// --- Sleeper -------------------------------------------------------------------------------------

export const sleeperCalls = registry.counter(
  'huddle_sleeper_requests_total',
  'Calls to the Sleeper API, by endpoint and outcome.',
  ['endpoint', 'outcome'],
);
export const sleeperFailures = registry.counter(
  'huddle_sleeper_failures_total',
  'Failed Sleeper calls, by error category.',
  ['endpoint', 'category'],
);
export const sleeperRetries = registry.counter(
  'huddle_sleeper_retries_total',
  'Sleeper calls retried, by the category that caused the retry.',
  ['endpoint', 'category'],
);
export const sleeperTimeouts = registry.counter(
  'huddle_sleeper_timeouts_total',
  'Sleeper calls that exhausted their timeout or their whole-call budget.',
  ['endpoint'],
);
export const sleeperDuration = registry.histogram(
  'huddle_sleeper_request_duration_seconds',
  'Time for one Sleeper call including its retries.',
  ['endpoint'],
);

// --- League synchronization ------------------------------------------------------------------------

export const syncRuns = registry.counter(
  'huddle_league_sync_runs_total',
  'League synchronizations, by outcome.',
  ['outcome'],
);
export const syncDuration = registry.histogram(
  'huddle_league_sync_duration_seconds',
  'Time to synchronize one league.',
  ['outcome'],
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
);
/**
 * The oldest successful synchronization across every active league, as a Unix timestamp.
 *
 * Per-league timestamps would be the obvious thing and are the wrong thing: a label per league is
 * unbounded in exactly the way this file refuses, and no alert is improved by knowing which of four
 * hundred leagues is oldest. The alert asks "is anything falling behind"; the runbook says how to
 * find which.
 */
export const syncOldestSuccess = registry.gauge(
  'huddle_league_sync_oldest_success_timestamp_seconds',
  'The least recent successful league synchronization, as a Unix timestamp. Zero when none has succeeded.',
);
export const syncLastSuccess = registry.gauge(
  'huddle_league_sync_last_success_timestamp_seconds',
  'The most recent successful league synchronization, as a Unix timestamp.',
);
export const syncStaleLeagues = registry.gauge(
  'huddle_league_sync_stale_leagues',
  'Active leagues whose last successful synchronization is older than the staleness threshold.',
);
export const syncFailingLeagues = registry.gauge(
  'huddle_league_sync_failing_leagues',
  'Active leagues whose last attempt failed, by how deep the consecutive failure streak is.',
  ['depth'],
);

/**
 * Scoring, which every ranking in this application is derived from.
 *
 * Separate from synchronization because they fail independently and need different people: a league
 * can be synchronizing perfectly while its scoring observation fails to validate, and the visible
 * symptom of that is not an error but advice that quietly stops being offered.
 */
export const scoringUnavailableLeagues = registry.gauge(
  'huddle_league_scoring_unavailable',
  'Active leagues whose live scoring did not validate. Their rankings are refused rather than estimated.',
);
export const scoringStaleLeagues = registry.gauge(
  'huddle_league_scoring_stale',
  'Active leagues whose scoring observation is older than the staleness threshold.',
);
export const scoringOldestObservation = registry.gauge(
  'huddle_league_scoring_oldest_observation_timestamp_seconds',
  'The least recent validated scoring observation across active leagues, as a Unix timestamp.',
);

// --- Forecasts ---------------------------------------------------------------------------------

export const forecastIngestedAt = registry.gauge(
  'huddle_forecast_ingested_timestamp_seconds',
  'When the retained forecast feed was ingested, as a Unix timestamp. Zero when there is no feed.',
);
export const forecastSourceUpdatedAt = registry.gauge(
  'huddle_forecast_source_updated_timestamp_seconds',
  "The source's own timestamp on the retained feed. A source that stops publishing keeps answering 200 with an old one.",
);
export const forecastPlayers = registry.gauge(
  'huddle_forecast_players',
  'Players in the retained forecast feed.',
);
export const forecastIdentityMatchRate = registry.gauge(
  'huddle_forecast_identity_match_rate',
  'Fraction of source players that resolved to a Sleeper id. An unmatched player is silently absent from every ranking.',
);
export const forecastCoverageComplete = registry.gauge(
  'huddle_forecast_coverage_complete',
  'Whether every category the live leagues score is supplied by the feed: 1 or 0.',
);
export const forecastIngestions = registry.counter(
  'huddle_forecast_ingestions_total',
  'Forecast ingestion runs, by status.',
  ['status'],
);
export const forecastBreaches = registry.counter(
  'huddle_forecast_breaches_total',
  'Service-level breaches observed at ingestion, by kind and severity.',
  ['kind', 'severity'],
);

// --- Recommendations -----------------------------------------------------------------------------

export const recommendationSections = registry.counter(
  'huddle_recommendation_sections_total',
  'Dashboard sections produced, by section and readiness state.',
  ['section', 'state'],
);
/**
 * Why advice could not be given.
 *
 * This application refuses to rank rather than ranking on incomplete inputs, so "unavailable" is a
 * designed outcome and not an error — which makes the *reason* the operational signal. Stale scoring
 * and a missing forecast need different people to do different things.
 */
export const recommendationsUnavailable = registry.counter(
  'huddle_recommendations_unavailable_total',
  'Recommendations withheld, by the reason they could not be produced.',
  ['section', 'reason'],
);

// --- Storage -------------------------------------------------------------------------------------

export const storageQueryDuration = registry.histogram(
  'huddle_storage_query_duration_seconds',
  'Time for one repository operation, by operation name.',
  ['operation'],
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
);
export const storageFailures = registry.counter(
  'huddle_storage_failures_total',
  'Repository operations that threw, by operation name.',
  ['operation'],
);
/**
 * Connection pool utilization.
 *
 * Registered but not populated by the JSON adapter, which has no pool: these series appear only once
 * an adapter reports them, because a gauge that is permanently zero because nothing feeds it renders
 * on a dashboard as a healthy number nobody questions. The PostgreSQL adapter supplies them through
 * `reportPoolStats`; see docs/storage.md.
 */
export const storagePoolConnections = registry.gauge(
  'huddle_storage_pool_connections',
  'Connections in the storage pool, by state. Absent for adapters that have no pool.',
  ['state'],
);
export interface PoolStats { total: number; idle: number; waiting: number }
export function reportPoolStats(stats: PoolStats | null) {
  if (!stats) { storagePoolConnections.clear(); return; }
  storagePoolConnections.set({ state: 'total' }, stats.total);
  storagePoolConnections.set({ state: 'idle' }, stats.idle);
  storagePoolConnections.set({ state: 'in_use' }, Math.max(0, stats.total - stats.idle));
  storagePoolConnections.set({ state: 'waiting' }, stats.waiting);
}

// --- The worker ----------------------------------------------------------------------------------

/**
 * How late the sweep is.
 *
 * The interval between when a sweep was due and when it actually started. It is the number that
 * separates "the worker is running" from "the worker is keeping up", and a heartbeat alone cannot
 * tell them apart: a worker stuck behind a slow upstream answers its probe perfectly.
 */
export const workerLag = registry.histogram(
  'huddle_worker_sweep_lag_seconds',
  'How far after its due time a sweep started.',
  [],
  [0.5, 1, 5, 15, 30, 60, 120, 300, 900],
);
export const workerHeartbeatAt = registry.gauge(
  'huddle_worker_heartbeat_timestamp_seconds',
  'When the process that owns the schedule last held its lease, as a Unix timestamp.',
);
export const workerQueueDepth = registry.gauge(
  'huddle_worker_queue_depth',
  'League synchronizations queued but not yet started.',
);
export const workerInFlight = registry.gauge(
  'huddle_worker_jobs_in_flight',
  'League synchronizations currently running.',
);
/**
 * Leases another holder already had.
 *
 * One worker is supposed to own the schedule, so a steady rate here is not contention — it is a
 * second worker that was not meant to be running, which is the thing `SYNC_WORKER_ENABLED=false`
 * exists to prevent and the thing nobody notices until the upstream call volume doubles.
 */
export const lockContention = registry.counter(
  'huddle_lock_contention_total',
  'Lease acquisitions refused because another holder had it, by lease.',
  ['lease'],
);

// --- Helpers used at the call sites ----------------------------------------------------------------

/** A Unix-seconds gauge set from an ISO timestamp, or left at zero when there is none. */
export const setTimestamp = (gauge: { set(labels: Labels, value: number): void }, at: string | null | undefined, labels: Labels = {}) =>
  gauge.set(labels, seconds(at));

export { LATENCY_BUCKETS, registry };
