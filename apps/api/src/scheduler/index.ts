/**
 * Background league synchronization.
 *
 * One worker owns every scheduled call to Sleeper: it loads the connected leagues, resolves the season
 * and week each one is actually in, synchronizes a bounded number of them at a time under leases that
 * hold across instances, honours upstream's retry guidance, records what each attempt did, and applies
 * the retention policy for leagues whose seasons are over. HTTP requests queue work here rather than
 * fanning out upstream themselves. See docs/league-sync.md.
 */
export { configureLeagueSyncWorker, leagueSyncWorkerOptions, syncWorkerEnabled } from './configure.js';
export { StoreSyncLock, workerIdentity, type LeaseHandle, type SyncLock } from './lock.js';
export { FINAL_WEEK, FIRST_WEEK, leagueIsHistorical, resolveSyncTarget, type SyncTarget, type WeekSource } from './week.js';
export {
  DEFAULT_RETENTION, LeagueSyncWorker, leagueLeaseKey, SWEEP_LEASE_KEY,
  type JobResult, type JobStatus, type LeagueSynchronizer, type LeagueSyncWorkerOptions,
  type QueuedSyncJob, type RetentionPolicy, type SweepReport, type SyncJob, type WorkerLogger,
} from './worker.js';
