import { SleeperApiError } from '@sleeper/sleeper-client';
import type { LeagueConnection } from '../store.js';
import type { LeagueConnectionRepository, LeagueRepository, LeaseRepository, SyncRunRepository } from '../storage/repositories.js';

/**
 * The connection set, the league metadata retention reads, per-resource freshness — and the leases,
 * which the worker only touches through the lock it builds when none is supplied.
 */
export type LeagueSyncWorkerRepository = LeagueConnectionRepository & LeagueRepository & SyncRunRepository & LeaseRepository;
import type { SyncResult } from '../sync.js';
import { StoreSyncLock, type LeaseHandle, type SyncLock } from './lock.js';
import { leagueIsHistorical, resolveSyncTarget } from './week.js';
import { logger } from '../log.js';

/**
 * The background league synchronization worker.
 *
 * It replaces an interval that only refreshed the sample league, and it is the single path through
 * which connected leagues reach Sleeper. Everything it does follows from two facts: Sleeper is a
 * shared free API that a fan-out can visibly overload, and a manager reading a dashboard would rather
 * see a snapshot from twenty minutes ago than wait on a request that is fetching seven endpoints.
 *
 * So work is queued rather than performed inside an HTTP request, a bounded number of leagues are in
 * flight at once, each league is guarded by a lease that spans instances, every attempt starts after a
 * random offset so a restart does not align every league on the same second, and a failure schedules
 * its own next attempt — at upstream's `Retry-After` when Sleeper sent one, and at a capped
 * exponential backoff when it did not. Nothing stored is ever removed by a failure: the last good
 * snapshot keeps being served, annotated with why it is not newer.
 */

export interface LeagueSynchronizer { syncLeague(leagueId: string, week: number, force?: boolean): Promise<SyncResult>; }
export interface WorkerLogger { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void; }

export interface SyncJob {
  leagueId: string;
  /** Why this job exists — `schedule`, `startup`, `manual`, `connect`. Recorded, never interpreted. */
  reason: string;
  force: boolean;
  week?: number;
  queuedAt: string;
}
/** A queued job plus the completion a caller can await. `done` never rejects: failures are results. */
export interface QueuedSyncJob extends SyncJob { readonly done: Promise<JobResult>; }
export type JobStatus = 'success' | 'failed' | 'skipped';
export interface JobResult {
  leagueId: string; status: JobStatus; reason: string; durationMs: number;
  season?: string; week?: number; category?: string; refreshed?: string[]; nextAttemptAt?: string;
}
export interface SweepReport {
  at: string; reason: string; considered: number; queued: string[]; skipped: Array<{ leagueId: string; reason: string }>;
  archived: string[]; pruned: string[]; results: JobResult[]; ranSweep: boolean;
}

/**
 * How long an inactive league is kept, and when its data is finally removed.
 *
 * Archiving and pruning are deliberately different decisions. Archiving stops scheduling a league
 * whose season can no longer change, and keeps every byte of it: last season's league is exactly what
 * a manager opens in March. Pruning removes data, so it additionally requires that no account links
 * the league any more — an archived league someone still has connected is never deleted underneath
 * them.
 */
export interface RetentionPolicy { archiveAfterMs: number; pruneAfterMs: number; }
export const DEFAULT_RETENTION: RetentionPolicy = { archiveAfterMs: 30 * 24 * 3_600_000, pruneAfterMs: 180 * 24 * 3_600_000 };

export interface LeagueSyncWorkerOptions {
  /** Upper bound on leagues in flight at once. The whole point of the worker; keep it small. */
  concurrency?: number;
  sweepIntervalMs?: number;
  /** Upper bound on the random offset applied before each attempt and to each next-attempt time. */
  jitterMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  leaseTtlMs?: number;
  retention?: RetentionPolicy;
  /** Whether the sample league may be scheduled at all. Production passes a function that is false. */
  demo?: () => boolean;
  demoLeagueIds?: readonly string[];
  runOnStart?: boolean;
  lock?: SyncLock;
  logger?: WorkerLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

export const SWEEP_LEASE_KEY = 'league-sync:sweep';
export const leagueLeaseKey = (leagueId: string) => `league-sync:league:${leagueId}`;

interface PendingJob extends SyncJob { done: Promise<JobResult>; settle: (result: JobResult) => void; }
const defaultLogger: WorkerLogger = { info: (fields, message) => logger.info({ component: 'league-sync', ...fields }, message), error: (fields, message) => logger.error({ component: 'league-sync', ...fields }, message) };
const wait = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export class LeagueSyncWorker {
  private readonly queue: PendingJob[] = [];
  /** One job per league from the moment it is queued until it settles, whether or not it has started. */
  private readonly pending = new Map<string, PendingJob>();
  private readonly inFlight = new Map<string, Promise<JobResult>>();
  private readonly workers = new Set<Promise<void>>();
  private readonly collectors = new Set<JobResult[]>();
  private sweeping: Promise<SweepReport> | null = null;
  private sweepLease: LeaseHandle | null = null;
  private timer: unknown = null;
  private stopped = true;
  private readonly options: Required<Omit<LeagueSyncWorkerOptions, 'setTimer' | 'clearTimer' | 'lock'>> & Pick<LeagueSyncWorkerOptions, 'setTimer' | 'clearTimer'>;
  private readonly lock: SyncLock;

  constructor(private readonly store: LeagueSyncWorkerRepository, private readonly sync: LeagueSynchronizer, options: LeagueSyncWorkerOptions = {}) {
    this.options = {
      concurrency: Math.max(1, options.concurrency ?? 3),
      sweepIntervalMs: Math.max(60_000, options.sweepIntervalMs ?? 30 * 60_000),
      jitterMs: Math.max(0, options.jitterMs ?? 20_000),
      baseRetryMs: Math.max(1_000, options.baseRetryMs ?? 60_000),
      maxRetryMs: Math.max(1_000, options.maxRetryMs ?? 60 * 60_000),
      leaseTtlMs: Math.max(1_000, options.leaseTtlMs ?? 10 * 60_000),
      retention: options.retention ?? DEFAULT_RETENTION,
      demo: options.demo ?? (() => false),
      demoLeagueIds: options.demoLeagueIds ?? ['demo'],
      runOnStart: options.runOnStart ?? true,
      logger: options.logger ?? defaultLogger,
      env: options.env ?? process.env,
      now: options.now ?? (() => new Date()),
      random: options.random ?? Math.random,
      sleep: options.sleep ?? wait,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    };
    this.lock = options.lock ?? new StoreSyncLock(store, undefined, this.options.now);
  }

  get owner() { return this.lock.owner; }
  /** What the API reports for a league the caller has just asked to refresh. */
  state(leagueId: string) { return { queued: this.pending.has(leagueId) && !this.inFlight.has(leagueId), running: this.inFlight.has(leagueId), position: this.queue.findIndex(job => job.leagueId === leagueId) + 1 }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.options.runOnStart) void this.sweep('startup').catch(error => this.options.logger.error({ message: String(error) }, '[league-sync] startup sweep failed'));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as Parameters<typeof clearTimeout>[0]);
    this.timer = null;
  }

  /**
   * Queues one league, coalescing with the job already waiting or running for it.
   *
   * Returning without waiting for the synchronization is the point: this is what a manual refresh
   * calls, and what makes the refresh a request to the worker rather than seven upstream calls held
   * open inside someone's HTTP request.
   */
  enqueue(leagueId: string, options: { reason?: string; force?: boolean; week?: number } = {}): QueuedSyncJob {
    // One job per league, whether the existing one is waiting or already running. A second press of
    // Refresh joins the synchronization in progress rather than queueing the same fan-out behind it —
    // the in-flight run is seconds old, and duplicating it is exactly the load this worker bounds.
    // A `force` that arrives after its job has started therefore takes effect on the next one.
    const existing = this.pending.get(leagueId);
    if (existing) {
      existing.force ||= Boolean(options.force);
      if (options.week !== undefined) existing.week = options.week;
      return existing;
    }
    let settle!: (result: JobResult) => void;
    const done = new Promise<JobResult>(resolve => { settle = resolve; });
    const job: PendingJob = { leagueId, reason: options.reason ?? 'manual', force: Boolean(options.force), week: options.week, queuedAt: this.options.now().toISOString(), done, settle };
    this.queue.push(job);
    this.pending.set(leagueId, job);
    this.pump();
    return job;
  }

  /**
   * Resolves once the queue is empty, with every job that finished while waiting.
   *
   * Waiting is not the same as starting the work: `enqueue` already started as much of it as the
   * concurrency limit allows, so a caller that never drains still gets its league synchronized.
   */
  async drain(): Promise<JobResult[]> {
    const collected: JobResult[] = [];
    this.collectors.add(collected);
    try {
      while (this.workers.size) await Promise.all([...this.workers]);
      return collected;
    } finally { this.collectors.delete(collected); }
  }

  /**
   * Resolves once this worker is holding nothing: no job in flight, no sweep part-way through.
   *
   * `drain` alone is not enough for a shutdown. The sweep releases its lease in a `finally` after the
   * jobs it queued have settled, and it queues leagues one at a time — so a drain can find the queue
   * momentarily empty while the sweep is still filling it, and can return before the lease has been
   * handed back. Draining, waiting for the sweep, then draining again covers both.
   */
  async settled(): Promise<void> {
    await this.drain();
    await this.sweeping?.catch(() => undefined);
    await this.drain();
  }

  /**
   * One pass over every connected league.
   *
   * The sweep lease is what makes this safe to run on every instance of a horizontally scaled
   * deployment: they all try, one wins, the rest return immediately having done nothing. A deployment
   * that would rather be explicit runs the worker on one instance or as a managed job and gets the
   * same behaviour with the lease never contended.
   */
  sweep(reason = 'schedule'): Promise<SweepReport> {
    if (!this.sweeping) this.sweeping = this.performSweep(reason).finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async performSweep(reason: string): Promise<SweepReport> {
    const at = this.options.now().toISOString();
    const report: SweepReport = { at, reason, considered: 0, queued: [], skipped: [], archived: [], pruned: [], results: [], ranSweep: false };
    const lease = await this.lock.acquire(SWEEP_LEASE_KEY, this.options.leaseTtlMs);
    if (!lease) {
      this.options.logger.info({ reason, owner: this.lock.owner }, '[league-sync] another worker holds the sweep lease');
      return report;
    }
    this.sweepLease = lease;
    report.ranSweep = true;
    try {
      await this.store.reconcileLeagueConnections(at, this.options.demoLeagueIds);
      const retention = await this.applyRetention();
      report.archived = retention.archived; report.pruned = retention.pruned;
      const connections = await this.store.activeLeagueConnections();
      report.considered = connections.length;
      const completions: Array<Promise<JobResult>> = [];
      for (const connection of connections) {
        const decision = await this.eligibility(connection);
        if (!decision.run) { report.skipped.push({ leagueId: connection.leagueId, reason: decision.reason }); continue; }
        completions.push(this.enqueue(connection.leagueId, { reason }).done);
        report.queued.push(connection.leagueId);
      }
      report.results = await Promise.all(completions);
      this.options.logger.info({ reason, considered: report.considered, queued: report.queued.length, skipped: report.skipped.length, archived: report.archived.length, pruned: report.pruned.length }, '[league-sync] sweep completed');
      return report;
    } finally {
      this.sweepLease = null;
      await lease.release();
    }
  }

  /** Why a connected league is or is not synchronized on this pass. */
  private async eligibility(connection: LeagueConnection): Promise<{ run: boolean; reason: string }> {
    if (connection.status !== 'active') return { run: false, reason: 'archived' };
    // The sample league is fiction. It is refreshed locally when the demo opt-in is on, and production
    // never schedules it whatever is stored, because production never serves it either.
    if (connection.demo && !this.options.demo()) return { run: false, reason: 'demo-disabled' };
    const now = this.options.now().getTime();
    if (connection.nextAttemptAt && Date.parse(connection.nextAttemptAt) > now) return { run: false, reason: 'awaiting-retry' };
    const league = await this.store.league(connection.leagueId);
    if (leagueIsHistorical(league, this.options.now(), this.options.env)) return { run: false, reason: 'historical' };
    return { run: true, reason: 'due' };
  }

  /**
   * Archives leagues whose season can no longer change, then prunes archived leagues nobody links.
   *
   * Both halves run before the queue is filled, so a sweep never spends a concurrency slot on a league
   * it is about to stop scheduling.
   */
  private async applyRetention(): Promise<{ archived: string[]; pruned: string[] }> {
    const now = this.options.now();
    const archived: string[] = [], pruned: string[] = [];
    for (const connection of await this.store.leagueConnections()) {
      if (connection.status === 'active') {
        const league = await this.store.league(connection.leagueId);
        if (!leagueIsHistorical(league, now, this.options.env)) continue;
        // Measured from the last successful synchronization, never from `updatedAt`: every sweep
        // touches that field, so an idle league would look busy and never reach the window.
        const idleSince = Date.parse(connection.lastSyncedAt ?? connection.createdAt);
        if (Number.isFinite(idleSince) && now.getTime() - idleSince < this.options.retention.archiveAfterMs) continue;
        await this.store.archiveLeagueConnection(connection.leagueId, 'inactive-season', now.toISOString());
        archived.push(connection.leagueId);
        continue;
      }
      // Data is only ever removed from a league no account still links: an archived league someone
      // still has connected is read-only history, not garbage.
      if (connection.linked || !connection.archivedAt) continue;
      if (now.getTime() - Date.parse(connection.archivedAt) < this.options.retention.pruneAfterMs) continue;
      await this.store.pruneLeague(connection.leagueId);
      pruned.push(connection.leagueId);
    }
    if (archived.length || pruned.length) this.options.logger.info({ archived, pruned }, '[league-sync] retention applied');
    return { archived, pruned };
  }

  /**
   * Runs as many workers as the limit allows for the work waiting now.
   *
   * Called on every enqueue rather than once per batch: a sweep queues leagues one at a time, and a
   * fixed pool started at the first of them would have exited before the rest arrived — leaving the
   * concurrency limit intact but the concurrency itself at one.
   */
  private pump(): void {
    while (this.workers.size < this.options.concurrency && this.queue.length > 0) {
      const worker = this.workerLoop();
      this.workers.add(worker);
      void worker.finally(() => this.workers.delete(worker));
    }
  }

  private async workerLoop(): Promise<void> {
    for (;;) {
      const job = this.queue.shift();
      if (!job) return;
      const result = await this.runJob(job);
      // Cleared before the waiters are resolved, so a caller that enqueues again the moment its own
      // refresh finishes gets a new job rather than joining one that is already over.
      this.pending.delete(job.leagueId);
      job.settle(result);
      for (const collector of this.collectors) collector.push(result);
      // A sweep can outlive one lease TTL when it has many leagues to work through.
      await this.sweepLease?.renew();
    }
  }

  /** Serializes attempts for one league inside this process before the cross-instance lease is tried. */
  private async runJob(job: SyncJob): Promise<JobResult> {
    const previous = this.inFlight.get(job.leagueId);
    if (previous) await previous.catch(() => undefined);
    const attempt = this.attempt(job).catch(error => {
      this.options.logger.error({ leagueId: job.leagueId, message: error instanceof Error ? error.message : String(error) }, '[league-sync] job failed outside synchronization');
      return { leagueId: job.leagueId, status: 'failed' as const, reason: job.reason, durationMs: 0, category: 'internal' };
    });
    this.inFlight.set(job.leagueId, attempt);
    try { return await attempt; }
    finally { if (this.inFlight.get(job.leagueId) === attempt) this.inFlight.delete(job.leagueId); }
  }

  private async attempt(job: SyncJob): Promise<JobResult> {
    const lease = await this.lock.acquire(leagueLeaseKey(job.leagueId), this.options.leaseTtlMs);
    if (!lease) {
      this.options.logger.info({ leagueId: job.leagueId }, '[league-sync] league is being synchronized by another worker');
      return { leagueId: job.leagueId, status: 'skipped', reason: 'lease-held', durationMs: 0 };
    }
    const started = this.options.now().getTime();
    const connection = await this.store.leagueConnection(job.leagueId);
    const league = await this.store.league(job.leagueId);
    const target = resolveSyncTarget({ league, connection, now: this.options.now(), env: this.options.env });
    const week = job.week ?? target.week;
    try {
      // Spread the fan-out. Without it a restart, or a schedule that lands on the same minute for every
      // league, turns N connected leagues into N simultaneous bursts of seven requests each.
      await this.options.sleep(Math.floor(this.options.random() * this.options.jitterMs));
      // Records the week being worked on before it is worked on, so a crash mid-sync leaves the
      // connection saying what it was doing. `connectLeague` is deliberately not used here: it would
      // re-link a connection nobody links any more.
      await this.store.updateLeagueConnection(job.leagueId, { season: target.season, week }, this.options.now().toISOString());
      const result = await this.sync.syncLeague(job.leagueId, week, job.force);
      const finishedAt = this.options.now();
      const nextAttemptAt = new Date(finishedAt.getTime() + this.options.sweepIntervalMs + this.randomJitter()).toISOString();
      await this.store.recordLeagueSyncAttempt(job.leagueId, {
        status: 'success', at: finishedAt.toISOString(), durationMs: finishedAt.getTime() - started,
        refreshed: result.refreshed, season: target.season, week, consecutiveFailures: 0,
        resourceFreshness: await this.store.resourceFreshness(job.leagueId), nextAttemptAt,
      });
      this.options.logger.info({ leagueId: job.leagueId, reason: job.reason, season: target.season, week, weekSource: target.source, refreshed: result.refreshed, durationMs: finishedAt.getTime() - started }, '[league-sync] league synchronized');
      return { leagueId: job.leagueId, status: 'success', reason: job.reason, durationMs: finishedAt.getTime() - started, season: target.season, week, refreshed: result.refreshed, nextAttemptAt };
    } catch (error) {
      const finishedAt = this.options.now();
      const category = error instanceof SleeperApiError ? error.category : 'internal';
      const failures = (connection?.consecutiveFailures ?? 0) + 1;
      // Upstream's own guidance outranks our backoff curve: a 429 that says sixty seconds means sixty
      // seconds, and retrying sooner is how a rate limit becomes a ban.
      const guided = error instanceof SleeperApiError ? error.retryAfterMs : null;
      const delay = Math.min(this.options.maxRetryMs, guided ?? this.options.baseRetryMs * 2 ** (failures - 1)) + this.randomJitter();
      const nextAttemptAt = new Date(finishedAt.getTime() + delay).toISOString();
      await this.store.recordLeagueSyncAttempt(job.leagueId, {
        status: 'failed', at: finishedAt.toISOString(), durationMs: finishedAt.getTime() - started, category,
        season: target.season, week, consecutiveFailures: failures,
        resourceFreshness: await this.store.resourceFreshness(job.leagueId), nextAttemptAt,
      });
      this.options.logger.error({ leagueId: job.leagueId, reason: job.reason, category, failures, retryAfterMs: guided, nextAttemptAt, message: error instanceof Error ? error.message : String(error) }, '[league-sync] league synchronization failed; last good snapshot retained');
      return { leagueId: job.leagueId, status: 'failed', reason: job.reason, durationMs: finishedAt.getTime() - started, season: target.season, week, category, nextAttemptAt };
    } finally {
      await lease.release();
    }
  }

  private randomJitter() { return Math.floor(this.options.random() * this.options.jitterMs); }

  private schedule(): void {
    if (this.stopped) return;
    const delay = this.options.sweepIntervalMs + this.randomJitter();
    const timer = (this.options.setTimer ?? setTimeout)(() => { void this.sweep('schedule').catch(error => this.options.logger.error({ message: String(error) }, '[league-sync] sweep failed')).finally(() => this.schedule()); }, delay);
    timer.unref?.();
    this.timer = timer;
  }
}
