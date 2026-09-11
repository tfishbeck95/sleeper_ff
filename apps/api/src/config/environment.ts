import { isAbsolute } from 'node:path';
import { insecureCookiesEnabled, sessionPolicy, validateAuthenticationConfig, type SessionPolicy } from '../auth.js';
import { instanceMode, storageConfiguration, type StorageConfiguration } from '../storage/configure.js';
import { parseWebOrigins } from './origins.js';
import { describeTrustProxy, parseTrustProxy, type TrustProxySetting } from './proxy.js';
import { describeUpstreamBudgets, resolveUpstreamBudgets, type UpstreamBudgets } from './upstream.js';

/**
 * One pass over the process environment, before anything is built from it.
 *
 * Every value this application reads is read somewhere, and most of them already refuse what they
 * cannot work with — `storageConfiguration` will not let production guess an adapter, `sessionPolicy`
 * will not accept a zero lifetime. What was missing is the pass that happens *first* and reports
 * *everything*: a deployment with three unset variables should learn all three at once rather than
 * one per restart, and the values that quietly fall back to a default when they are misspelled should
 * stop doing that.
 *
 * The silent fallbacks are the reason this module exists at all. `Number(process.env.PORT)` on a typo
 * is `NaN`, and `listen(NaN)` binds a random free port — a container that passes its health check on a
 * port nothing routes to. `SYNC_WORKER_ENABLED=no` reads as enabled, because the only value that
 * disables it is the exact string `false`, so a fleet that meant to run one worker runs one per
 * instance. `SYNC_CONCURRENCY=ten` is three. None of those fail; they just do something else, months
 * later, in production.
 *
 * Nothing here re-implements a check that already exists. The existing validators are called, their
 * messages are kept verbatim, and this adds the checks that had no home: the port, the shapes of the
 * booleans and numbers, the forecast credential, and the relationships between values that are only
 * wrong together.
 */

export type RuntimeMode = 'development' | 'test' | 'production';
const RUNTIME_MODES: readonly RuntimeMode[] = ['development', 'test', 'production'];

/** Every problem found in one pass, rather than the first one that happened to be checked. */
export class EnvironmentError extends Error {
  constructor(readonly problems: string[]) {
    const prefix = problems.length === 1 ? 'Refusing to start:' : `Refusing to start: ${problems.length} configuration problems.`;
    super([prefix, ...problems.map(problem => `  - ${problem.replace(/^Refusing to start:\s*/, '')}`)].join('\n'));
    this.name = 'EnvironmentError';
  }
}

export interface SyncConfiguration {
  /** Whether this process owns the schedule. */
  workerEnabled: boolean;
  intervalMs: number;
  concurrency: number;
  leaseTtlMs: number;
}

export interface ProjectionFeedConfiguration {
  enabled: boolean;
  /** Present, never the value: a credential in a log or a crash report is a leaked credential. */
  credentialConfigured: boolean;
  timeZone: string;
  /** The file-based forecast adapter, which serves forecasts whether or not the licensed feed is on. */
  waiverSignalsPath?: string;
}

export interface RuntimeConfiguration {
  mode: RuntimeMode;
  production: boolean;
  port: number;
  /** Exact origins allowed to send credentialed requests. */
  webOrigins: string[];
  trustProxy: TrustProxySetting;
  /** How long any call to somebody else's server may take, per profile. See `config/upstream.ts`. */
  upstream: UpstreamBudgets;
  storage: StorageConfiguration;
  session: SessionPolicy;
  sync: SyncConfiguration;
  projectionFeed: ProjectionFeedConfiguration;
  /** The worker's liveness probe, when one is asked for. Unset means it binds nothing. */
  workerHealthPort?: number;
  /**
   * The port `/metrics` and the probes are served on, when one is asked for.
   *
   * Separate from the application port because a scrape is an operational disclosure — route names,
   * traffic volumes, error rates, how many leagues are connected — and belongs on an internal
   * network rather than behind a token in somebody's scrape configuration. Unset binds nothing.
   */
  metricsPort?: number;
  /** How often the worker evaluates the alert conditions. */
  alertIntervalMs: number;
  /** How long shutdown waits for in-flight work before the process exits anyway. */
  shutdownGraceMs: number;
  demoEnabled: boolean;
  /** Configuration that is allowed, and worth saying out loud. */
  warnings: string[];
}

const HOUR = 3_600_000, MINUTE = 60_000, SECOND = 1_000, DAY = 24 * HOUR;

interface NumberRule {
  /** Inclusive. */
  min?: number;
  /** Inclusive. */
  max?: number;
  integer?: boolean;
  /** Multiplied onto the parsed value, so callers name minutes and read milliseconds. */
  unit?: number;
}

/**
 * A collector rather than a thrower.
 *
 * Each check appends what it found and carries on, so one pass names every problem. The alternative —
 * throwing on the first — is what makes configuring a new environment a sequence of restarts.
 */
class Problems {
  readonly list: string[] = [];
  readonly warnings: string[] = [];

  add(problem: string) { this.list.push(problem); }
  warn(warning: string) { this.warnings.push(warning); }

  /** Runs a validator that throws, keeping its message exactly as it wrote it. */
  attempt<T>(check: () => T): T | undefined {
    try { return check(); } catch (error) { this.add(error instanceof Error ? error.message : String(error)); return undefined; }
  }

  number(env: NodeJS.ProcessEnv, name: string, fallback: number, rule: NumberRule = {}): number {
    const unit = rule.unit ?? 1;
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback * unit;
    const value = Number(raw);
    const bounds = describeBounds(rule);
    if (!Number.isFinite(value) || (rule.integer && !Number.isInteger(value))) { this.add(`${name} must be ${bounds}, not '${raw}'.`); return fallback * unit; }
    if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) { this.add(`${name} must be ${bounds}, not '${raw}'.`); return fallback * unit; }
    return value * unit;
  }

  /**
   * A flag is `true` or `false` and nothing else.
   *
   * `SYNC_WORKER_ENABLED=no` is the case this exists for: read as "not the string false", it enables
   * the worker on every instance of a fleet that was being told to run exactly one.
   */
  flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const normalized = raw.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    this.add(`${name} must be 'true' or 'false', not '${raw}'. Anything else is read as one of them and silently does the other thing.`);
    return fallback;
  }
}

function describeBounds(rule: NumberRule): string {
  const kind = rule.integer ? 'a whole number' : 'a number';
  if (rule.min !== undefined && rule.max !== undefined) return `${kind} between ${rule.min} and ${rule.max}`;
  if (rule.min === 0) return `${kind} of zero or more`;
  if (rule.min !== undefined) return `${kind} of at least ${rule.min}`;
  if (rule.max !== undefined) return `${kind} of at most ${rule.max}`;
  return kind;
}

/** The runtime mode, refusing a value that is not one of the three this application branches on. */
export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const raw = env.NODE_ENV?.trim();
  if (!raw) return 'development';
  if (!RUNTIME_MODES.includes(raw as RuntimeMode)) {
    // Every production refusal in this application — demo authentication, insecure cookies, a guessed
    // storage adapter, a plain-http origin — is a `NODE_ENV === 'production'` comparison. `prod` or
    // `Production` passes none of them, so a typo here disables all of them at once.
    throw new EnvironmentError([`NODE_ENV must be one of ${RUNTIME_MODES.join(', ')}, not '${raw}'. Every production safeguard is an exact comparison against 'production'.`]);
  }
  return raw as RuntimeMode;
}

/**
 * Validates the whole environment and returns what the process should be built from.
 *
 * Throws `EnvironmentError` naming every problem at once. Callers log it and exit; nothing is
 * constructed from a configuration that did not pass.
 */
export interface ValidationContext {
  /**
   * Whether this process binds an application port. The worker does not, and settings that only
   * mean something to a request — the trusted-proxy hop count — are not demanded of it.
   */
  servesHttp?: boolean;
}

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env, { servesHttp = true }: ValidationContext = {}): RuntimeConfiguration {
  const found = new Problems();
  const mode = found.attempt(() => runtimeMode(env)) ?? 'development';
  const production = mode === 'production';

  // --- The port the API binds ---
  // `listen(NaN)` is a free port chosen by the kernel, which passes its own health check and receives
  // nothing, so a port that cannot be parsed is refused rather than defaulted.
  const port = found.number(env, 'PORT', 4000, { min: 1, max: 65_535, integer: true });

  // --- Origins allowed to send credentialed requests ---
  found.attempt(() => validateAuthenticationConfig(env, { servesHttp }));
  const webOrigins = found.attempt(() => parseWebOrigins(env.WEB_ORIGIN, { production })) ?? [];
  const origins = webOrigins.length ? webOrigins : production ? [] : ['http://localhost:5173'];

  // --- Session material ---
  const session = found.attempt(() => sessionPolicy(env)) ?? sessionPolicy({});
  const login = env.APP_LOGIN_USER;
  if (login !== undefined) {
    if (!login.trim()) found.add('APP_LOGIN_USER is set but empty. Leave it unset to use the default login, or name one.');
    // Sign-in lowercases and trims what the browser sent before looking the account up, but the account
    // seeded at startup is stored under this value verbatim. `Admin` therefore creates an account that
    // nothing can ever match, and the only symptom is a password that is always wrong.
    else if (login !== login.trim().toLowerCase()) found.add(`APP_LOGIN_USER must be lowercase and unpadded — sign-in lowercases the submitted login, so '${login}' would seed an account nothing can sign in to. Use '${login.trim().toLowerCase()}'.`);
  }
  const passwordHash = env.APP_LOGIN_PASSWORD_HASH?.trim();
  // Outside production `validateAuthenticationConfig` does not look at the shape of the hash; a
  // malformed one is then indistinguishable from a wrong password at the sign-in screen.
  if (passwordHash && !production && !/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(passwordHash)) {
    found.add('APP_LOGIN_PASSWORD_HASH is not a scrypt hash. Generate one with npm run password-hash -w @sleeper/api.');
  }
  // A production deployment with no credential at all is already refused by
  // `validateAuthenticationConfig`; nothing is added here beyond its message.

  // --- Storage, the database URL, and how many instances share it ---
  found.attempt(() => instanceMode(env));
  const storage = found.attempt(() => storageConfiguration(env)) ?? { adapter: 'json' as const, instanceMode: 'single' as const, defaulted: true, warnings: [] };
  if (storage.adapter === 'postgres') validateDatabaseUrl(env.DATABASE_URL, found);
  for (const warning of storage.warnings) found.warn(warning);

  // --- Intervals, budgets and retention windows ---
  const workerEnabled = found.flag(env, 'SYNC_WORKER_ENABLED', true);
  const intervalMs = found.number(env, 'SYNC_INTERVAL_MINUTES', 30, { min: 1, unit: MINUTE });
  const concurrency = found.number(env, 'SYNC_CONCURRENCY', 3, { min: 1, integer: true });
  found.number(env, 'SYNC_JITTER_SECONDS', 20, { min: 0, unit: SECOND });
  const baseRetryMs = found.number(env, 'SYNC_RETRY_BASE_SECONDS', 60, { min: 1, unit: SECOND });
  const maxRetryMs = found.number(env, 'SYNC_RETRY_MAX_MINUTES', 60, { min: 1, unit: MINUTE });
  // A ceiling below the first delay is not a smaller backoff, it is no backoff: every retry clamps to
  // the ceiling, so a rate-limited upstream is retried at a fixed rate forever.
  if (baseRetryMs > maxRetryMs) found.add(`SYNC_RETRY_MAX_MINUTES must be at least SYNC_RETRY_BASE_SECONDS (${baseRetryMs / SECOND}s), otherwise every retry clamps to the ceiling and the backoff never grows.`);
  const leaseTtlMs = found.number(env, 'SYNC_LEASE_MINUTES', 10, { min: 1, unit: MINUTE });
  found.number(env, 'SYNC_ARCHIVE_AFTER_DAYS', 30, { min: 1, unit: DAY });
  found.number(env, 'SYNC_PRUNE_AFTER_DAYS', 180, { min: 1, unit: DAY });
  const shutdownGraceMs = found.number(env, 'SHUTDOWN_GRACE_SECONDS', 20, { min: 1, unit: SECOND });
  // The worker serves no application traffic, so an orchestrator has nothing to ask it. Naming a port
  // gives it a liveness probe; leaving it unset binds nothing.
  const workerHealthPort = env.WORKER_HEALTH_PORT?.trim() ? found.number(env, 'WORKER_HEALTH_PORT', 0, { min: 1, max: 65_535, integer: true }) : undefined;
  if (workerHealthPort !== undefined && workerHealthPort === port) found.add(`WORKER_HEALTH_PORT and PORT are both ${port}. They are different processes; only one of them can bind it.`);
  const metricsPort = env.METRICS_PORT?.trim() ? found.number(env, 'METRICS_PORT', 0, { min: 1, max: 65_535, integer: true }) : undefined;
  // Both are bound by the same process in a single-instance deployment, and a collision there is a
  // port that silently serves whichever listener won rather than an error anybody sees.
  if (metricsPort !== undefined && metricsPort === port) found.add(`METRICS_PORT and PORT are both ${port}. The application and the metrics endpoint are separate listeners; only one of them can bind it.`);
  if (metricsPort !== undefined && workerHealthPort !== undefined && metricsPort === workerHealthPort) found.add(`METRICS_PORT and WORKER_HEALTH_PORT are both ${metricsPort}.`);
  const alertIntervalMs = found.number(env, 'OPS_ALERT_INTERVAL_MINUTES', 5, { min: 1, unit: MINUTE });
  found.number(env, 'OPS_ALERT_REPEAT_MINUTES', 60, { min: 1 });
  const opsWebhook = env.OPS_ALERT_WEBHOOK?.trim();
  if (opsWebhook) {
    let url: URL | undefined;
    try { url = new URL(opsWebhook); } catch { found.add('OPS_ALERT_WEBHOOK must be an absolute https URL.'); }
    // An alert names which part of the installation is unwell; it is not sent over plain http.
    if (url && url.protocol !== 'https:') found.add('OPS_ALERT_WEBHOOK must use https.');
  }

  // --- Forecast sources and their credentials ---
  const projectionFeed = validateProjectionFeed(env, found);

  // --- Reverse proxies ---
  // One parser, shared with the application, so what is validated here is what Express is told.
  const trustProxy = found.attempt(() => parseTrustProxy(env.TRUST_PROXY, { production, servesHttp })) ?? false;

  // A configurable upstream supports private mirrors and deterministic contract replay.
  if (env.SLEEPER_API_BASE_URL !== undefined) {
    try {
      const url = new URL(env.SLEEPER_API_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        found.add('SLEEPER_API_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.');
    } catch { found.add('SLEEPER_API_BASE_URL must be an absolute HTTP(S) base URL.'); }
  }

  // --- Upstream timeout and retry budgets ---
  const upstream = validateUpstreamBudgets(env, found, shutdownGraceMs);

  const demoEnabled = found.flag(env, 'ENABLE_DEMO_AUTH', false) && !production;
  found.flag(env, 'INSECURE_DEV_COOKIES', false);
  if (insecureCookiesEnabled(env)) found.warn('INSECURE_DEV_COOKIES is enabled: session cookies drop the __Host- prefix and the Secure attribute. Never enable this on a reachable host.');

  if (found.list.length) throw new EnvironmentError(found.list);
  return {
    mode, production, port, webOrigins: origins, trustProxy, upstream, storage, session,
    sync: { workerEnabled, intervalMs, concurrency, leaseTtlMs },
    projectionFeed, workerHealthPort, metricsPort, alertIntervalMs, shutdownGraceMs, demoEnabled, warnings: found.warnings,
  };
}

/**
 * The upstream budgets, and the two relationships that make them coherent.
 *
 * A total shorter than one attempt is a budget that can never complete a call, and a total longer
 * than the shutdown grace period means a drain either abandons a request in flight or waits past the
 * deadline an orchestrator will kill the process at. Neither fails at startup on its own; both
 * produce a confusing failure much later, under load, which is the only time they matter.
 */
function validateUpstreamBudgets(env: NodeJS.ProcessEnv, found: Problems, shutdownGraceMs: number): UpstreamBudgets {
  found.number(env, 'UPSTREAM_TIMEOUT_SECONDS', 10, { min: 1, max: 120, unit: SECOND });
  found.number(env, 'UPSTREAM_MAX_ATTEMPTS', 3, { min: 1, max: 10, integer: true });
  found.number(env, 'UPSTREAM_REQUEST_BUDGET_SECONDS', 20, { min: 1, max: 300, unit: SECOND });
  found.number(env, 'UPSTREAM_BACKGROUND_BUDGET_SECONDS', 90, { min: 1, max: 900, unit: SECOND });
  const budgets = resolveUpstreamBudgets(env);
  const { interactive } = budgets;
  if (interactive.maxElapsedMs < interactive.timeoutMs) {
    found.add(`UPSTREAM_REQUEST_BUDGET_SECONDS (${interactive.maxElapsedMs / SECOND}s) is shorter than UPSTREAM_TIMEOUT_SECONDS (${interactive.timeoutMs / SECOND}s), so no attempt could ever finish inside the budget.`);
  }
  if (interactive.maxElapsedMs > shutdownGraceMs) {
    found.warn(`UPSTREAM_REQUEST_BUDGET_SECONDS (${interactive.maxElapsedMs / SECOND}s) is longer than SHUTDOWN_GRACE_SECONDS (${shutdownGraceMs / SECOND}s), so a request waiting on an upstream call can be cut short by a drain rather than finishing it.`);
  }
  return budgets;
}

/**
 * The connection string, checked for shape and never quoted back.
 *
 * `storageConfiguration` already refuses a missing one. What it cannot check is whether the value is a
 * PostgreSQL URL at all: a connection string pasted with the `psql` in front of it, or a host with no
 * database on the end, fails on the first query rather than at startup — and the error that reports it
 * tends to carry the password.
 */
function validateDatabaseUrl(value: string | undefined, found: Problems): void {
  const raw = value?.trim();
  if (!raw) return; // Already refused by storageConfiguration; one message is enough.
  let url: URL;
  try { url = new URL(raw); } catch { found.add('DATABASE_URL is not a URL. Expected postgres://user:password@host:port/database. The value is not repeated here because it carries a password.'); return; }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') found.add(`DATABASE_URL must use the postgres:// or postgresql:// scheme, not '${url.protocol.replace(':', '')}://'.`);
  if (!url.hostname) found.add('DATABASE_URL names no host.');
  if (!url.pathname.replace(/^\//, '')) found.add('DATABASE_URL names no database. Expected postgres://user:password@host:port/database.');
}

/**
 * The forecast sources.
 *
 * The licensed feed is off unless it is switched on, and switching it on without a key is refused here
 * rather than at the first ingestion window: an empty fetch is indistinguishable at the storage layer
 * from a week in which nobody was projected.
 */
function validateProjectionFeed(env: NodeJS.ProcessEnv, found: Problems): ProjectionFeedConfiguration {
  const enabled = found.flag(env, 'PROJECTION_FEED_ENABLED', false);
  const credential = env.SPORTSDATAIO_API_KEY?.trim();
  if (enabled && !credential) {
    found.add('PROJECTION_FEED_ENABLED=true requires SPORTSDATAIO_API_KEY. Without it the adapter publishes an empty feed, which is indistinguishable from a week nobody was projected in. See docs/projection-provider.md.');
  }
  // The placeholder from `.env.example`, copied forward. It authenticates nothing, and the failure it
  // produces is an upstream 401 in the middle of an ingestion window.
  if (enabled && credential && /^(your-subscription-key|changeme|replace-me|xxx+)$/i.test(credential)) {
    found.add('SPORTSDATAIO_API_KEY is still the placeholder from .env.example.');
  }

  found.number(env, 'PROJECTION_FEED_STALE_HOURS', 12, { min: 0 });
  found.number(env, 'PROJECTION_FEED_MAX_SOURCE_AGE_HOURS', 6, { min: 0 });
  found.number(env, 'PROJECTION_FEED_MIN_IDENTITY_MATCH', 0.95, { min: 0, max: 1 });
  found.number(env, 'PROJECTION_FEED_MIN_PLAYERS', 300, { min: 0, integer: true });
  found.flag(env, 'PROJECTION_FEED_REQUIRE_COMPLETE_COVERAGE', false);

  const webhook = env.PROJECTION_FEED_ALERT_WEBHOOK?.trim();
  if (webhook) {
    let url: URL | undefined;
    try { url = new URL(webhook); } catch { found.add(`PROJECTION_FEED_ALERT_WEBHOOK must be an absolute https URL, not '${webhook}'.`); }
    // Alerts describe which league's coverage broke and how; they are not sent over plain http.
    if (url && url.protocol !== 'https:') found.add('PROJECTION_FEED_ALERT_WEBHOOK must use https.');
  }

  const timeZone = env.PROJECTION_FEED_TIME_ZONE?.trim() || 'America/New_York';
  // The ingestion windows are defined in the NFL's own time zone; an unknown one throws inside the
  // schedule the first time it computes a window, which is hours after startup.
  try { new Intl.DateTimeFormat('en-US', { timeZone }); }
  catch { found.add(`PROJECTION_FEED_TIME_ZONE must be an IANA time zone such as America/New_York, not '${timeZone}'.`); }

  const season = env.NFL_SEASON?.trim();
  if (season && !/^\d{4}$/.test(season)) found.add(`NFL_SEASON must be a four-digit year, not '${season}'.`);
  const anchor = env.NFL_WEEK_ONE_TUESDAY?.trim();
  if (anchor && Number.isNaN(Date.parse(anchor))) found.add(`NFL_WEEK_ONE_TUESDAY must be a date such as 2025-09-02, not '${anchor}'.`);

  const waiverSignalsPath = env.WAIVER_SIGNALS_PATH?.trim();
  // Read with no base, so a relative path means something different to every process depending on
  // where it was started — and in a container, somewhere that does not exist.
  if (waiverSignalsPath && !isAbsolute(waiverSignalsPath)) found.add(`WAIVER_SIGNALS_PATH must be an absolute path, not '${waiverSignalsPath}'. It is read relative to the working directory otherwise, which differs between a development shell and a container.`);
  if (!enabled && !waiverSignalsPath) {
    found.warn('No forecast source is configured (PROJECTION_FEED_ENABLED is off and WAIVER_SIGNALS_PATH is unset). Waiver, trade and lineup advice will report an explicit unavailable state rather than ranking anything.');
  }

  return { enabled, credentialConfigured: Boolean(credential), timeZone, waiverSignalsPath };
}

/**
 * One line per process, safe to log.
 *
 * Nothing here is a secret: the storage description already omits the connection string, and the
 * forecast credential appears only as whether there is one.
 */
export function describeEnvironment(configuration: RuntimeConfiguration): string {
  const parts = [
    `mode=${configuration.mode}`,
    `port=${configuration.port}`,
    `origins=${configuration.webOrigins.join(' ') || 'none'}`,
    `proxies=${describeTrustProxy(configuration.trustProxy)}`,
    `upstream=${describeUpstreamBudgets(configuration.upstream)}`,
    `storage=${configuration.storage.adapter}/${configuration.storage.instanceMode}`,
    `worker=${configuration.sync.workerEnabled ? 'enabled' : 'disabled'}`,
    `sync-interval=${configuration.sync.intervalMs / MINUTE}m`,
    `forecast-feed=${configuration.projectionFeed.enabled ? 'enabled' : 'off'}`,
  ];
  if (configuration.metricsPort) parts.push(`metrics=:${configuration.metricsPort}`);
  if (configuration.demoEnabled) parts.push('demo=enabled');
  return parts.join(', ');
}
