import type { CoverageReport } from './coverage.js';
import type { DerivationNote } from './derivation.js';
import type { IdentityResolution } from './identity.js';
import type { FeedProvenance, UnresolvedIdentity } from './provider.js';
import { logger } from '../log.js';
import { forecastBreaches, forecastIngestions } from '../observability/instruments.js';

/**
 * What one ingestion did, and whether it was good enough to rely on.
 *
 * The report is stored beside the feed rather than only logged, because every question worth asking
 * about a projection — why is this player missing, why does this defense have no shutout bonus, how
 * old is this — is answered by the ingestion that produced it, not by the feed's contents.
 */

export type IngestionStatus = 'published' | 'rejected' | 'failed';

export interface IngestionReport {
  season: string;
  week: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * `published` wrote a new feed. `rejected` means the candidate feed failed validation and the last
   * good feed was deliberately kept. `failed` means the run never produced a candidate at all.
   */
  status: IngestionStatus;
  provenance: FeedProvenance | null;
  players: number;
  /** Resolved players that still produced no feed entry, so `players` never has to be explained. */
  omitted: { noProjection: number };
  identity: IdentityResolution['stats'];
  /** Bounded for storage; `unresolvedTotal` is the true count so a truncated list cannot mislead. */
  unresolved: UnresolvedIdentity[];
  unresolvedTotal: number;
  coverage: CoverageReport | null;
  derivations: DerivationNote[];
  schema: { valid: boolean; error: string | null };
  /** Floor/ceiling availability, so "no ceilings anywhere" reads as a source property, not a bug. */
  scenarios: { supported: boolean; withFloor: number; withCeiling: number };
  errors: string[];
  breaches: ServiceLevelBreach[];
}

/**
 * The thresholds below which a feed is not fit to rank anyone's lineup.
 *
 * These are deliberately explicit numbers rather than implicit behaviour. A feed that silently
 * degrades — a source that drops kickers, an identity map that goes stale after roster cuts — still
 * produces confident-looking rankings, and the only thing standing between that and a manager acting
 * on it is a stated level and something that notices when it is missed.
 */
export interface ServiceLevel {
  /** Fraction of source players that must resolve to a Sleeper id. */
  minIdentityMatchRate: number;
  /** How old the *source's own* timestamp may be before the feed is no longer current. */
  maxSourceAgeMs: number;
  /** How long since our last successful ingestion before the retained feed is marked stale. */
  maxIngestionAgeMs: number;
  /** When true, any scored category the league pays and the feed omits is a breach, not a note. */
  requireCompleteCoverage: boolean;
  /** A floor on volume: a source returning six players is an outage wearing a 200 response. */
  minPlayers: number;
}

export const DEFAULT_SERVICE_LEVEL: ServiceLevel = Object.freeze({
  minIdentityMatchRate: 0.95,
  maxSourceAgeMs: 6 * 60 * 60_000,
  maxIngestionAgeMs: 12 * 60 * 60_000,
  requireCompleteCoverage: false,
  minPlayers: 300,
});

export type BreachKind = 'coverage' | 'freshness' | 'identity' | 'schema' | 'volume';
export interface ServiceLevelBreach {
  kind: BreachKind;
  severity: 'warning' | 'critical';
  message: string;
  observed: string;
  threshold: string;
}

/**
 * Grades one ingestion against the level.
 *
 * Severity separates "this feed is unusable" from "this feed is usable and something is wrong".
 * A schema failure or an empty result is critical because the alternative is serving nothing; a
 * coverage gap is a warning by default because a league that pays for a category nobody projects is
 * still better served by the categories that are projected, provided the gap is disclosed.
 */
export function evaluateServiceLevel(report: Omit<IngestionReport, 'breaches'>, level: ServiceLevel = DEFAULT_SERVICE_LEVEL, now = Date.now()): ServiceLevelBreach[] {
  const breaches: ServiceLevelBreach[] = [];
  const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;

  if (!report.schema.valid) breaches.push({
    kind: 'schema', severity: 'critical',
    message: `The candidate feed failed schema validation and was not published: ${report.schema.error ?? 'unknown error'}`,
    observed: 'invalid', threshold: 'valid',
  });

  if (report.status !== 'failed' && report.players < level.minPlayers) breaches.push({
    kind: 'volume', severity: 'critical',
    message: `Only ${report.players} players were ingested; a source returning far fewer players than a roster-wide feed needs is an outage that answered 200.`,
    observed: `${report.players} players`, threshold: `>= ${level.minPlayers}`,
  });

  if (report.identity.total > 0 && report.identity.rate < level.minIdentityMatchRate) breaches.push({
    kind: 'identity', severity: report.identity.rate < level.minIdentityMatchRate * 0.8 ? 'critical' : 'warning',
    message: `${(report.identity.rate * 100).toFixed(1)}% of source players resolved to a Sleeper id (${report.identity.resolved}/${report.identity.total}); ${report.unresolvedTotal} did not. An unmatched player is silently absent from every ranking.`,
    observed: `${(report.identity.rate * 100).toFixed(1)}%`, threshold: `>= ${(level.minIdentityMatchRate * 100).toFixed(0)}%`,
  });

  if (report.provenance) {
    const sourceAge = now - Date.parse(report.provenance.sourceTimestamp);
    if (Number.isFinite(sourceAge) && sourceAge > level.maxSourceAgeMs) breaches.push({
      kind: 'freshness', severity: sourceAge > level.maxSourceAgeMs * 2 ? 'critical' : 'warning',
      message: `The source's own timestamp is ${hours(sourceAge)} old. The fetch succeeded, so this is the source failing to publish rather than the ingestion failing to run.`,
      observed: hours(sourceAge), threshold: `<= ${hours(level.maxSourceAgeMs)}`,
    });
  }

  if (report.coverage && !report.coverage.complete) breaches.push({
    kind: 'coverage', severity: level.requireCompleteCoverage ? 'critical' : 'warning',
    message: report.coverage.summary,
    observed: `${report.coverage.uncovered.length} uncovered, ${report.coverage.unsupported.length} unsupported`, threshold: 'every scored rule supplied',
  });

  return breaches;
}

/** Staleness of a retained feed, evaluated at read time rather than baked in at write time. */
export function stalenessOf(ingestedAt: string, level: ServiceLevel = DEFAULT_SERVICE_LEVEL, now = Date.now()): { stale: boolean; ageMs: number; reason: string | null } {
  const ageMs = now - Date.parse(ingestedAt);
  if (!Number.isFinite(ageMs)) return { stale: true, ageMs: Number.NaN, reason: 'The retained feed carries no readable ingestion timestamp.' };
  const stale = ageMs > level.maxIngestionAgeMs;
  return {
    stale, ageMs,
    reason: stale ? `The last successful ingestion was ${(ageMs / 3_600_000).toFixed(1)}h ago, past the ${(level.maxIngestionAgeMs / 3_600_000).toFixed(1)}h staleness threshold.` : null,
  };
}

export interface AlertEvent {
  season: string;
  week: number;
  status: IngestionStatus;
  severity: 'warning' | 'critical';
  breaches: ServiceLevelBreach[];
  /** Present for a failure that produced no report at all. */
  error?: string;
  report?: IngestionReport;
}
export interface Alerter { alert(event: AlertEvent): Promise<void> | void }

/** The default: structured to stderr, where a container's log pipeline already collects it. */
export class ConsoleAlerter implements Alerter {
  constructor(private readonly log: (fields: Record<string, unknown>, message: string) => void = (fields, message) => logger.error({ component: 'projection-feed', ...fields }, message)) {}
  alert(event: AlertEvent) {
    this.log({
      season: event.season, week: event.week, status: event.status, severity: event.severity,
      breaches: event.breaches.map(breach => ({ kind: breach.kind, severity: breach.severity, observed: breach.observed, threshold: breach.threshold, message: breach.message })),
      ...(event.error ? { error: event.error } : {}),
    }, '[projection-feed] service level breached');
  }
}

/**
 * Posts to an operations webhook when one is configured.
 *
 * A failure to alert never fails an ingestion: a feed that published correctly must not be discarded
 * because a chat integration was down, and the console alerter has already recorded the breach.
 */
export class WebhookAlerter implements Alerter {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch, private readonly fallback: Alerter = new ConsoleAlerter(), private readonly timeoutMs = 5_000) {}
  async alert(event: AlertEvent) {
    await this.fallback.alert(event);
    try {
      await this.fetcher(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Projection feed ${event.status} for ${event.season} week ${event.week}: ${event.breaches.length} service-level breach(es)`,
          severity: event.severity,
          breaches: event.breaches,
          ...(event.error ? { error: event.error } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      logger.error({ component: 'projection-feed', error }, 'alert delivery failed');
    }
  }
}

/** Fans out to several destinations; one failing destination never suppresses the others. */
/**
 * Records what an ingestion run produced, alongside whatever alerting it triggers.
 *
 * Counted at the point the run is judged rather than at the point it is delivered, so a webhook that
 * is unreachable costs an alert and never a metric.
 */
export class MeteredAlerter implements Alerter {
  constructor(private readonly inner: Alerter) {}
  async alert(event: AlertEvent) {
    forecastIngestions.inc({ status: event.status });
    for (const breach of event.breaches) forecastBreaches.inc({ kind: breach.kind, severity: breach.severity });
    await this.inner.alert(event);
  }
}

export class CompositeAlerter implements Alerter {
  constructor(private readonly alerters: Alerter[]) {}
  async alert(event: AlertEvent) { await Promise.allSettled(this.alerters.map(async alerter => alerter.alert(event))); }
}

export const highestSeverity = (breaches: ServiceLevelBreach[]): 'warning' | 'critical' =>
  breaches.some(breach => breach.severity === 'critical') ? 'critical' : 'warning';
