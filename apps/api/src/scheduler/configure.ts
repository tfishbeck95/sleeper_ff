import { demoEnabled } from '../auth.js';
import type { JsonStore } from '../store.js';
import { StoreSyncLock, workerIdentity } from './lock.js';
import { DEFAULT_RETENTION, LeagueSyncWorker, type LeagueSynchronizer, type LeagueSyncWorkerOptions } from './worker.js';

/**
 * Worker configuration from the process environment.
 *
 * The defaults are the ones a single connected league on one instance wants, and every value that a
 * larger deployment has to raise or lower is named rather than buried: how many leagues may be in
 * flight, how far attempts are spread, how long a failure waits, how long a lease lives, and how long
 * an inactive league is kept before it is archived and finally pruned.
 */

const minutes = (value: string | undefined, fallback: number) => { const parsed = Number(value); return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 60_000; };
const seconds = (value: string | undefined, fallback: number) => { const parsed = Number(value); return (Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback) * 1_000; };
const days = (value: string | undefined, fallback: number) => { const parsed = Number(value); return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 24 * 3_600_000; };
const count = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; };

/**
 * Whether this process runs the schedule.
 *
 * Defaults to true so a single-container deployment needs no configuration. A deployment that runs the
 * API on several instances sets it false everywhere except the one worker — and if it forgets, the
 * sweep lease still means only one of them synchronizes anything.
 */
export const syncWorkerEnabled = (env: NodeJS.ProcessEnv = process.env) => (env.SYNC_WORKER_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

export function leagueSyncWorkerOptions(env: NodeJS.ProcessEnv = process.env): LeagueSyncWorkerOptions {
  return {
    concurrency: count(env.SYNC_CONCURRENCY, 3),
    sweepIntervalMs: minutes(env.SYNC_INTERVAL_MINUTES, 30),
    jitterMs: seconds(env.SYNC_JITTER_SECONDS, 20),
    baseRetryMs: seconds(env.SYNC_RETRY_BASE_SECONDS, 60),
    maxRetryMs: minutes(env.SYNC_RETRY_MAX_MINUTES, 60),
    leaseTtlMs: minutes(env.SYNC_LEASE_MINUTES, 10),
    retention: {
      archiveAfterMs: days(env.SYNC_ARCHIVE_AFTER_DAYS, DEFAULT_RETENTION.archiveAfterMs / (24 * 3_600_000)),
      pruneAfterMs: days(env.SYNC_PRUNE_AFTER_DAYS, DEFAULT_RETENTION.pruneAfterMs / (24 * 3_600_000)),
    },
    // Not a flag of its own: the sample league is scheduled exactly when the application is willing to
    // serve it at all, which production refuses regardless of what is configured.
    demo: () => demoEnabled(env),
    env,
  };
}

export function configureLeagueSyncWorker(store: JsonStore, sync: LeagueSynchronizer, options: LeagueSyncWorkerOptions = {}, env: NodeJS.ProcessEnv = process.env): LeagueSyncWorker {
  const fromEnv = leagueSyncWorkerOptions(env);
  return new LeagueSyncWorker(store, sync, { ...fromEnv, lock: new StoreSyncLock(store, workerIdentity(env)), ...options });
}
