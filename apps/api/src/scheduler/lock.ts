import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { LeaseRepository } from '../storage/repositories.js';

/**
 * The synchronization lock.
 *
 * Two different races are covered by the same seam. Within a process, two sweeps or a sweep and a
 * manual refresh must not synchronize one league twice at once. Across instances, exactly one process
 * must own the schedule, because every duplicated sweep is a duplicated fan-out at Sleeper.
 *
 * A lease expires rather than being held until a clean release, so an instance killed mid-sweep does
 * not stop the schedule until an operator intervenes. `renew` exists for work that legitimately
 * outlives one TTL — a sweep over many leagues — and returns false once the lease has been lost, which
 * is the honest answer for a caller that then has to stop.
 */

export interface LeaseHandle {
  readonly key: string;
  readonly owner: string;
  expiresAt: string;
  renew(ttlMs?: number): Promise<boolean>;
  release(): Promise<void>;
}

export interface SyncLock {
  readonly owner: string;
  acquire(key: string, ttlMs: number): Promise<LeaseHandle | null>;
}

/** Stable per-process identity, overridable so a managed job can name its own worker. */
export function workerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SYNC_WORKER_ID?.trim();
  return configured || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

type LeaseStore = Pick<LeaseRepository, 'acquireLease' | 'releaseLease'>;

/**
 * Leases held in the same store as the data.
 *
 * Within one process this is genuinely mutually exclusive: the store serializes every write, and the
 * read-modify-write that takes a lease happens inside one of them. Two processes sharing one JSON file
 * can still interleave between read and rename, which is why the local profile is documented as
 * single-instance. A horizontally scaled deployment implements `SyncLock` over the same table it
 * already runs on — `SELECT ... FOR UPDATE`, an advisory lock, or `SET NX PX` — and nothing above this
 * interface changes. See docs/league-sync.md.
 */
export class StoreSyncLock implements SyncLock {
  constructor(private readonly store: LeaseStore, readonly owner = workerIdentity(), private readonly now: () => Date = () => new Date()) {}

  async acquire(key: string, ttlMs: number): Promise<LeaseHandle | null> {
    const lease = await this.store.acquireLease(key, this.owner, ttlMs, this.now());
    if (!lease) return null;
    const handle: LeaseHandle = {
      key, owner: this.owner, expiresAt: lease.expiresAt,
      renew: async (renewMs = ttlMs) => {
        const renewed = await this.store.acquireLease(key, this.owner, renewMs, this.now());
        if (renewed) handle.expiresAt = renewed.expiresAt;
        return Boolean(renewed);
      },
      release: () => this.store.releaseLease(key, this.owner),
    };
    return handle;
  }
}
