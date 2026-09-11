import { logger, type Logger } from '../log.js';
import { httpRequests, storageFailures } from './instruments.js';
import type { DependencyStatus, DependencyThresholds } from './health.js';
import { DEFAULT_THRESHOLDS } from './health.js';

/**
 * The six things worth waking somebody for, and nothing else.
 *
 * An alert set is judged by what it *does not* contain. Every rule here has three properties, and a
 * rule that cannot claim all three does not belong:
 *
 * 1. **It is actionable.** There is a step in `docs/runbook.md` that a person can take, and each
 *    alert carries the anchor to it. An alert with no action is a notification, and notifications
 *    train people to close alerts without reading them.
 * 2. **It describes symptoms, not causes.** "Nothing has synchronized for three hours" is a symptom;
 *    "the sweep lease is held by a dead worker" is one of several causes of it. Alerting on causes
 *    means every new cause needs a new alert, and the ones nobody thought of are silent.
 * 3. **It is quiet when nothing is wrong.** Every rule is a threshold crossed for a duration, not an
 *    event, and repeats are suppressed for `repeatAfterMs`. A worker that has been down for an hour
 *    is one alert, not sixty.
 *
 * What deliberately has no rule: a single failed synchronization (Sleeper is a free shared API and
 * retries are the design), a single 5xx (that is what the error budget is for), and a forecast that
 * is merely absent (an installation with no data licence is a supported configuration, and the
 * engines already report it as an explicit unavailable state rather than ranking on nothing).
 */

export type AlertSeverity = 'warning' | 'critical';

export interface OperationalAlert {
  /** Stable, and the anchor of its section in the runbook. Never generated from a message. */
  id: AlertId;
  severity: AlertSeverity;
  /** One line an operator reads first. Numbers and states only: no paths, hosts or identifiers. */
  summary: string;
  /** The numbers behind the summary, for a dashboard link or a ticket. */
  detail: Record<string, number | string | boolean | null>;
  runbook: string;
  firedAt: string;
}

export type AlertId =
  | 'stale-scoring'
  | 'stale-projections'
  | 'repeated-sync-failures'
  | 'worker-inactive'
  | 'elevated-5xx'
  | 'storage-failures';

const RUNBOOK = (id: AlertId) => `docs/runbook.md#${id}`;

export interface AlertSink { deliver(alert: OperationalAlert): Promise<void> | void }

/** The default. Structured to the process log, where a container's pipeline already collects it. */
export class LoggingAlertSink implements AlertSink {
  constructor(private readonly log: Logger = logger) {}
  deliver(alert: OperationalAlert) {
    const fields = { component: 'alerts', alert: alert.id, severity: alert.severity, runbook: alert.runbook, ...alert.detail };
    if (alert.severity === 'critical') this.log.error(fields, alert.summary);
    else this.log.warn(fields, alert.summary);
  }
}

/**
 * An operations webhook.
 *
 * The URL is itself the credential, so it is never logged and never attached to an error — the
 * fallback reports that delivery failed, not where it was being delivered.
 */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly fallback: AlertSink = new LoggingAlertSink(),
    private readonly timeoutMs = 5_000,
  ) {}
  async deliver(alert: OperationalAlert) {
    try {
      const response = await this.fetcher(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`webhook returned ${response.status}`);
    } catch (error) {
      // An alert that could not be delivered is still an alert. It goes to the log rather than being
      // dropped, because the delivery failure and the condition are two separate problems.
      logger.error({ component: 'alerts', alert: alert.id, error }, 'alert delivery failed');
      await this.fallback.deliver(alert);
    }
  }
}

export class CompositeAlertSink implements AlertSink {
  constructor(private readonly sinks: readonly AlertSink[]) {}
  async deliver(alert: OperationalAlert) { for (const sink of this.sinks) await sink.deliver(alert); }
}

/**
 * Suppresses a condition that is still the same condition.
 *
 * Keyed on the alert id and severity, so an escalation from warning to critical is delivered
 * immediately rather than swallowed by the window that the warning opened.
 */
export class DeduplicatingSink implements AlertSink {
  private readonly lastDelivered = new Map<string, number>();
  constructor(private readonly inner: AlertSink, private readonly repeatAfterMs = 60 * 60_000, private readonly now = () => Date.now()) {}
  async deliver(alert: OperationalAlert) {
    const key = `${alert.id}:${alert.severity}`;
    const at = this.now();
    const previous = this.lastDelivered.get(key);
    if (previous !== undefined && at - previous < this.repeatAfterMs) return;
    this.lastDelivered.set(key, at);
    await this.inner.deliver(alert);
  }
  /** Called when a condition clears, so its recurrence is reported rather than suppressed. */
  clear(id: AlertId) { for (const key of [...this.lastDelivered.keys()]) if (key.startsWith(`${id}:`)) this.lastDelivered.delete(key); }
}

/** Counts read from the registry since the previous evaluation, which is what makes them a rate. */
export interface TrafficDelta { requests: number; serverErrors: number; storageFailures: number }

export interface AlertThresholds extends DependencyThresholds {
  /** Fraction of requests that may be 5xx over one evaluation window before it is a problem. */
  maxServerErrorRate: number;
  /** Below this many requests a rate is noise: three requests, one of them a 500, is not 33%. */
  minRequestsForRate: number;
  /** Repository failures in one window before storage is reported as failing rather than flaky. */
  maxStorageFailures: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  ...DEFAULT_THRESHOLDS,
  maxServerErrorRate: 0.05,
  minRequestsForRate: 20,
  maxStorageFailures: 5,
};

/**
 * Turns a dependency reading into the alerts it justifies.
 *
 * Pure, and separate from delivery, so the interesting half — which numbers mean which severity —
 * is testable without a clock, a sink or a store.
 */
export function evaluate(status: DependencyStatus, traffic: TrafficDelta, thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS, at = new Date().toISOString()): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const fire = (id: AlertId, severity: AlertSeverity, summary: string, detail: OperationalAlert['detail']) =>
    alerts.push({ id, severity, summary, detail, runbook: RUNBOOK(id), firedAt: at });

  // --- Scoring ---------------------------------------------------------------------------------
  // Scoring is the input every ranking is derived from, so a stale observation is not a degraded
  // dashboard — it is advice priced against rules that may have changed. The engines already refuse
  // to rank on it; this is what tells somebody to go and fix it.
  if (status.scoring.unavailable > 0) {
    fire('stale-scoring', status.scoring.unavailable === status.scoring.leagues ? 'critical' : 'warning',
      `Live scoring is unvalidated for ${status.scoring.unavailable} of ${status.scoring.leagues} active leagues; their lineup, waiver and trade rankings are unavailable.`,
      { leagues: status.scoring.leagues, unavailable: status.scoring.unavailable, stale: status.scoring.stale, oldestObservedAt: status.scoring.oldestObservedAt });
  } else if (status.scoring.stale > 0) {
    fire('stale-scoring', 'warning',
      `Scoring observations are stale for ${status.scoring.stale} of ${status.scoring.leagues} active leagues.`,
      { leagues: status.scoring.leagues, stale: status.scoring.stale, oldestObservedAt: status.scoring.oldestObservedAt });
  }

  // --- Projections -----------------------------------------------------------------------------
  // Only a configured feed can be stale. An installation with no data licence is supported, and its
  // forecast state is `unavailable` by design rather than by failure, so it raises nothing here.
  if (status.forecast.state === 'stale') {
    fire('stale-projections', 'critical',
      `The retained forecast feed is ${Math.round((status.forecast.ageSeconds ?? 0) / 3600)}h old and has stopped answering requests.`,
      { ageSeconds: status.forecast.ageSeconds, ingestedAt: status.forecast.ingestedAt, sourceUpdatedAt: status.forecast.sourceUpdatedAt, players: status.forecast.players });
  } else if (status.forecast.state === 'degraded' && status.forecast.reason) {
    fire('stale-projections', 'warning',
      status.forecast.reason === 'identity_match_below_threshold'
        ? `Only ${((status.forecast.identityMatchRate ?? 0) * 100).toFixed(1)}% of forecast players resolve to a Sleeper id; the rest are silently absent from every ranking.`
        : `The forecast feed is degraded: ${status.forecast.reason}.`,
      { reason: status.forecast.reason, identityMatchRate: status.forecast.identityMatchRate, players: status.forecast.players, coverageComplete: status.forecast.coverageComplete });
  }

  // --- Synchronization --------------------------------------------------------------------------
  // A streak, never a single failure: Sleeper is a free shared API, a failed attempt is expected,
  // and the backoff exists precisely so that one does not need a person.
  if (status.leagueSync.state === 'unavailable') {
    fire('repeated-sync-failures', 'critical',
      `No active league has synchronized recently; all ${status.leagueSync.activeLeagues} are stale.`,
      { activeLeagues: status.leagueSync.activeLeagues, staleLeagues: status.leagueSync.staleLeagues, worstFailureStreak: status.leagueSync.worstFailureStreak, lastSuccessAt: status.leagueSync.lastSuccessAt });
  } else if (status.leagueSync.staleLeagues > 0 || status.leagueSync.worstFailureStreak >= thresholds.failureStreak) {
    fire('repeated-sync-failures', 'warning',
      `${status.leagueSync.staleLeagues} of ${status.leagueSync.activeLeagues} leagues are stale; the deepest failure streak is ${status.leagueSync.worstFailureStreak}.`,
      { activeLeagues: status.leagueSync.activeLeagues, staleLeagues: status.leagueSync.staleLeagues, failingLeagues: status.leagueSync.failingLeagues, worstFailureStreak: status.leagueSync.worstFailureStreak, oldestSuccessAt: status.leagueSync.oldestSuccessAt });
  }

  // --- The worker ------------------------------------------------------------------------------
  // Nothing else notices this. Every API instance keeps serving the last good snapshot perfectly
  // while the schedule that refreshes it is dead, so a silent worker is an outage that looks like
  // uptime until somebody sets a lineup from a week-old roster.
  if (status.worker.state === 'unavailable') {
    fire('worker-inactive', 'critical',
      status.worker.heartbeatAt
        ? `The schedule has not been claimed for ${Math.round((status.worker.ageSeconds ?? 0) / 60)} minutes; no league is being refreshed.`
        : 'No process has ever claimed the schedule; no league is being refreshed.',
      { heartbeatAt: status.worker.heartbeatAt, ageSeconds: status.worker.ageSeconds, held: status.worker.held });
  }

  // --- Serving ---------------------------------------------------------------------------------
  // A rate over a window, with a floor under the denominator: one 500 out of three requests at four
  // in the morning is not a 33% error rate, and paging on it is how an alert set loses its audience.
  if (traffic.requests >= thresholds.minRequestsForRate) {
    const rate = traffic.serverErrors / traffic.requests;
    if (rate > thresholds.maxServerErrorRate) {
      fire('elevated-5xx', rate > 0.25 ? 'critical' : 'warning',
        `${(rate * 100).toFixed(1)}% of requests in the last window failed with a 5xx.`,
        { requests: traffic.requests, serverErrors: traffic.serverErrors, rate: Number(rate.toFixed(4)) });
    }
  }

  // --- Storage ---------------------------------------------------------------------------------
  // Distinct from readiness: readiness answers "can this instance serve", this answers "is storage
  // failing under load while still answering a probe", which is the shape a failing disk takes.
  if (traffic.storageFailures > thresholds.maxStorageFailures) {
    fire('storage-failures', 'critical',
      `${traffic.storageFailures} repository operations failed in the last window.`,
      { failures: traffic.storageFailures });
  }

  return alerts;
}

// --- Reading the counters ------------------------------------------------------------------------

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;

/**
 * Reads the cumulative counters and returns what changed since the previous call.
 *
 * Kept here rather than in the registry because it is alerting's concern: a time-series database
 * computes rates from cumulative counters properly, and this is the smaller thing that lets an
 * installation with no monitoring stack still be told when it is on fire.
 */
export class TrafficWindow {
  private previous: TrafficDelta = { requests: 0, serverErrors: 0, storageFailures: 0 };
  read(): TrafficDelta {
    const current = { requests: 0, serverErrors: 0, storageFailures: 0 };
    for (const series of httpRequests.snapshot()) {
      current.requests += series.value;
      if (series.labels.status === '5xx') current.serverErrors += series.value;
    }
    for (const series of storageFailures.snapshot()) current.storageFailures += series.value;
    const delta: TrafficDelta = {
      // A counter only goes up, so a negative delta means the process restarted; the window starts
      // again rather than reporting a negative rate.
      requests: Math.max(0, current.requests - this.previous.requests),
      serverErrors: Math.max(0, current.serverErrors - this.previous.serverErrors),
      storageFailures: Math.max(0, current.storageFailures - this.previous.storageFailures),
    };
    this.previous = current;
    return delta;
  }
}

export { STATUS_CLASSES };
