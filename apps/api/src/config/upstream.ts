import { SleeperClient, type SleeperCallObservation } from '@sleeper/sleeper-client';
import { ProviderHttpClient, type ProviderHttpOptions } from '../providers/http.js';
import { sleeperCalls, sleeperDuration, sleeperFailures, sleeperRetries, sleeperTimeouts } from '../observability/instruments.js';

/**
 * How long this application will wait on somebody else's server, decided in one place.
 *
 * There were three answers to that before this file: Sleeper's client waited 10 seconds and retried
 * twice, the licensed provider's client waited 15 and retried three times, and the reference-data
 * adapter passed 30 at its own construction site. None of them bounded the *total*, which is the
 * number that actually matters — three attempts of fifteen seconds plus backoff is a request held
 * open for the best part of a minute, and the caller on the other end of it gave up long ago.
 *
 * So a budget here is a whole budget: what one attempt may take, how many attempts there may be, how
 * long a wait between them may grow, and the ceiling on all of it together. The elapsed ceiling is
 * what makes the others safe to tune — no combination of them can produce a call that outlives it.
 *
 * Three profiles, because the calls genuinely differ in who is waiting:
 *
 * - **`interactive`** — a browser is blocked on this. The budget is shorter than a person's patience
 *   and shorter than the shutdown grace period, so a drain never has to abandon one.
 * - **`background`** — the worker's ingestion window. Nobody is waiting, the run is scheduled, and a
 *   source that is briefly unwell is worth more attempts than a source a dashboard is blocked on.
 * - **`bulk`** — reference data published as multi-megabyte CSV. The attempt is long because the
 *   transfer is, not because the source is slow to answer.
 *
 * The two clients already categorize failures identically — timeout, network, rate_limit, server and
 * so on — which is what lets `http/errors.ts` classify both from one table. This file is the other
 * half of that agreement: the same categories, retried on the same terms, for the same total time.
 */

export interface UpstreamBudget {
  /** The ceiling on one attempt, including connection and transfer. */
  timeoutMs: number;
  /** Attempts in total, the first one included. `1` disables retrying. */
  maxAttempts: number;
  /** The first backoff wait; each subsequent one doubles it, with full jitter. */
  backoffMs: number;
  /** The ceiling on a single backoff wait. */
  maxBackoffMs: number;
  /** The ceiling on everything: attempts, waits, and the gaps between them. */
  maxElapsedMs: number;
}

export type UpstreamProfile = 'interactive' | 'background' | 'bulk';

const SECOND = 1_000;

export const DEFAULT_UPSTREAM_BUDGETS: Record<UpstreamProfile, UpstreamBudget> = {
  interactive: { timeoutMs: 10 * SECOND, maxAttempts: 3, backoffMs: 200, maxBackoffMs: 2 * SECOND, maxElapsedMs: 20 * SECOND },
  background: { timeoutMs: 15 * SECOND, maxAttempts: 4, backoffMs: 500, maxBackoffMs: 20 * SECOND, maxElapsedMs: 90 * SECOND },
  bulk: { timeoutMs: 30 * SECOND, maxAttempts: 3, backoffMs: SECOND, maxBackoffMs: 20 * SECOND, maxElapsedMs: 180 * SECOND },
};

export type UpstreamBudgets = Record<UpstreamProfile, UpstreamBudget>;

/**
 * The budgets for this process.
 *
 * Read once at startup and cached, so every client built anywhere in the process agrees — including
 * the ones constructed as default parameters, which have no configuration handed to them. The values
 * themselves are validated by `validateEnvironment`, which refuses a total shorter than one attempt
 * rather than silently producing a budget that can never complete a call.
 */
let cached: UpstreamBudgets | undefined;

export function upstreamBudgets(env: NodeJS.ProcessEnv = process.env): UpstreamBudgets {
  if (cached) return cached;
  cached = resolveUpstreamBudgets(env);
  return cached;
}

/** Test-only: forgets the cached budgets so a suite can configure its own. */
export function resetUpstreamBudgets() { cached = undefined; }

const seconds = (raw: string | undefined, fallbackMs: number) => {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(value) && value > 0 ? value * SECOND : fallbackMs;
};
const count = (raw: string | undefined, fallback: number) => {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(value) && value >= 1 ? value : fallback;
};

/**
 * Applies the environment's overrides to the defaults.
 *
 * Only the numbers an operator has a reason to move are exposed: how long an interactive call may
 * take in total, how long one attempt may take, how many attempts, and the background total. The
 * backoff shape is derived, because a backoff base that is not related to the timeout is a knob that
 * only produces wrong answers.
 */
export function resolveUpstreamBudgets(env: NodeJS.ProcessEnv = process.env): UpstreamBudgets {
  const timeoutMs = seconds(env.UPSTREAM_TIMEOUT_SECONDS, DEFAULT_UPSTREAM_BUDGETS.interactive.timeoutMs);
  const maxAttempts = count(env.UPSTREAM_MAX_ATTEMPTS, DEFAULT_UPSTREAM_BUDGETS.interactive.maxAttempts);
  const interactiveTotal = seconds(env.UPSTREAM_REQUEST_BUDGET_SECONDS, DEFAULT_UPSTREAM_BUDGETS.interactive.maxElapsedMs);
  const backgroundTotal = seconds(env.UPSTREAM_BACKGROUND_BUDGET_SECONDS, DEFAULT_UPSTREAM_BUDGETS.background.maxElapsedMs);
  return {
    interactive: { ...DEFAULT_UPSTREAM_BUDGETS.interactive, timeoutMs, maxAttempts, maxElapsedMs: interactiveTotal },
    background: { ...DEFAULT_UPSTREAM_BUDGETS.background, maxAttempts: Math.max(maxAttempts, DEFAULT_UPSTREAM_BUDGETS.background.maxAttempts), maxElapsedMs: backgroundTotal },
    bulk: { ...DEFAULT_UPSTREAM_BUDGETS.bulk, maxElapsedMs: Math.max(DEFAULT_UPSTREAM_BUDGETS.bulk.maxElapsedMs, backgroundTotal) },
  };
}

/**
 * Turns one call into the counters an operator reads.
 *
 * Retries are counted rather than inferred: a call that succeeded on its third attempt is a success
 * *and* two retries, and a dashboard that only sees the success cannot tell a healthy upstream from
 * one that is failing two out of every three requests.
 */
export function observeSleeperCall(observation: SleeperCallObservation) {
  const { endpoint, attempts, outcome } = observation;
  sleeperCalls.inc({ endpoint, outcome });
  sleeperDuration.observe({ endpoint }, observation.durationMs / 1000);
  if (attempts > 1) sleeperRetries.inc({ endpoint, category: observation.category ?? 'unknown' }, attempts - 1);
  if (outcome === 'failure') {
    sleeperFailures.inc({ endpoint, category: observation.category ?? 'unknown' });
    if (observation.category === 'timeout') sleeperTimeouts.inc({ endpoint });
  }
}

/**
 * A Sleeper client on a named budget, reporting what each call did.
 *
 * Every construction site in the application goes through here, which is what makes both the budget
 * and the measurement properties of the deployment rather than of whichever module built the client.
 */
export function sleeperClient(profile: UpstreamProfile = 'interactive', fetcher?: typeof fetch, env: NodeJS.ProcessEnv = process.env): SleeperClient {
  const budget = upstreamBudgets(env)[profile];
  return new SleeperClient(fetcher, env.SLEEPER_API_BASE_URL?.replace(/\/$/, ""), {
    observe: observeSleeperCall,
    timeoutMs: budget.timeoutMs,
    maxRetries: budget.maxAttempts - 1,
    backoffMs: budget.backoffMs,
    // Upstream's own `Retry-After` is honoured only while it fits inside the budget. A longer one is
    // handed back on the error for the worker to schedule, rather than held open inside a request.
    maxRetryAfterMs: Math.min(budget.maxBackoffMs, budget.maxElapsedMs),
    maxElapsedMs: budget.maxElapsedMs,
  });
}

/** The same, for a licensed provider's client. */
export function providerHttpOptions(profile: UpstreamProfile, overrides: ProviderHttpOptions = {}, env: NodeJS.ProcessEnv = process.env): ProviderHttpOptions {
  const budget = upstreamBudgets(env)[profile];
  return {
    timeoutMs: overrides.timeoutMs ?? budget.timeoutMs,
    maxRetries: overrides.maxRetries ?? budget.maxAttempts - 1,
    backoffMs: overrides.backoffMs ?? budget.backoffMs,
    maxBackoffMs: overrides.maxBackoffMs ?? budget.maxBackoffMs,
    maxElapsedMs: overrides.maxElapsedMs ?? budget.maxElapsedMs,
  };
}

export function providerHttpClient(source: string, profile: UpstreamProfile, fetcher?: typeof fetch, overrides: ProviderHttpOptions = {}): ProviderHttpClient {
  return new ProviderHttpClient(source, fetcher, providerHttpOptions(profile, overrides));
}

/** One line per profile, for the startup log. Nothing here is a secret. */
export const describeUpstreamBudgets = (budgets: UpstreamBudgets): string =>
  (Object.keys(budgets) as UpstreamProfile[])
    .map(profile => `${profile}=${budgets[profile].timeoutMs / SECOND}s×${budgets[profile].maxAttempts}/${budgets[profile].maxElapsedMs / SECOND}s`)
    .join(' ');
