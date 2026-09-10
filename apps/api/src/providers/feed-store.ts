import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseWaiverSignals, type WaiverSignalProvider, type WaiverSignals } from '../waiver-signals.js';
import type { FeedProvenance } from './provider.js';
import { DEFAULT_SERVICE_LEVEL, stalenessOf, type IngestionReport, type ServiceLevel } from './service-level.js';

/**
 * Durable storage for the validated feed.
 *
 * Two properties matter more than the storage medium. A reader must never observe a half-written
 * feed, and a failed ingestion must leave the last good feed in place rather than truncating it —
 * a feed that is six hours old and known to be six hours old is useful, and one that is absent
 * because a fetch timed out is not.
 */

export interface StoredFeed {
  provenance: FeedProvenance;
  feed: WaiverSignals;
  report: IngestionReport;
}

/**
 * The persistence seam. `write` is only ever called with a feed that has already passed
 * `parseWaiverSignals`, so a repository never has to decide whether its contents are valid.
 *
 * A PostgreSQL implementation is a drop-in: one row per (season, week) with the feed as `jsonb`, an
 * `ingested_at` column, and an upsert in place of the rename. See docs/projection-provider.md.
 */
export interface FeedRepository {
  read(): Promise<StoredFeed | null>;
  write(value: StoredFeed): Promise<void>;
}

/**
 * Temporary file, fsync, rename.
 *
 * The rename is what makes a reader see either the old feed or the new one and never a partial file.
 * The fsync before it is what makes that still true after a power loss: without it the rename can
 * reach the disk before the bytes it points at.
 */
export class FileFeedRepository implements FeedRepository {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async read(): Promise<StoredFeed | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoredFeed;
      // Storage is not a trust boundary, but a hand-edited or partially restored file should fail
      // here rather than reach the scoring boundary as an unexplained batch of rejections.
      parseWaiverSignals(parsed?.feed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  write(value: StoredFeed): Promise<void> {
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = join(dirname(this.path), `.${process.pid}.${Date.now()}.feed.tmp`);
      const handle = await open(temp, 'w');
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally { await handle.close(); }
      try { await rename(temp, this.path); }
      catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}

/** For tests and for a deployment that keeps the feed only in a shared cache. */
export class InMemoryFeedRepository implements FeedRepository {
  constructor(private value: StoredFeed | null = null) {}
  async read() { return this.value; }
  async write(value: StoredFeed) { this.value = value; }
}

export interface FeedState {
  provenance: FeedProvenance;
  report: IngestionReport;
  /** True once the retained feed is older than the configured threshold. It is kept either way. */
  stale: boolean;
  ageMs: number;
  staleReason: string | null;
  /** False when the retained feed is for a different season or week than the one being asked about. */
  matchesRequest: boolean;
  players: number;
}

/**
 * Reads the stored feed and decides, at read time, whether it is still current.
 *
 * Staleness is computed on read rather than stamped on write because it is a function of *now*. A
 * feed written twenty minutes ago and a feed written twenty hours ago are the same bytes; only the
 * reading clock separates them, and a flag written at ingestion would be permanently wrong.
 */
export class ProjectionFeedStore implements WaiverSignalProvider {
  constructor(
    private readonly repository: FeedRepository,
    private readonly level: ServiceLevel = DEFAULT_SERVICE_LEVEL,
    private readonly now = () => Date.now(),
  ) {}

  async state(season?: string, week?: number): Promise<FeedState | null> {
    const stored = await this.repository.read();
    if (!stored) return null;
    const staleness = stalenessOf(stored.provenance.ingestedAt, this.level, this.now());
    return {
      provenance: stored.provenance, report: stored.report,
      stale: staleness.stale, ageMs: staleness.ageMs, staleReason: staleness.reason,
      matchesRequest: (season === undefined || stored.feed.season === season) && (week === undefined || stored.feed.week === week),
      players: stored.feed.players.length,
    };
  }

  /**
   * The `WaiverSignalProvider` contract the waiver, lineup and trade engines already consume.
   *
   * A stale or mismatched feed returns null rather than a best-effort answer, which the engines
   * surface as the documented explicit unavailable state. Serving a week-old projection as though it
   * were this week's is the one failure mode a manager cannot detect from the recommendation itself.
   */
  async load(season: string, week: number): Promise<WaiverSignals | null> {
    const stored = await this.repository.read();
    if (!stored) return null;
    if (stored.feed.season !== season || stored.feed.week !== week) return null;
    return stalenessOf(stored.provenance.ingestedAt, this.level, this.now()).stale ? null : stored.feed;
  }

  async publish(value: StoredFeed): Promise<void> { await this.repository.write(value); }
}
