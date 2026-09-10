import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WaiverSignals } from '../waiver-signals.js';
import { FileFeedRepository, InMemoryFeedRepository, ProjectionFeedStore, type StoredFeed } from './feed-store.js';
import type { FeedProvenance } from './provider.js';
import { DEFAULT_SERVICE_LEVEL, stalenessOf, type IngestionReport } from './service-level.js';

const HOUR = 3_600_000;
const feed = (season = '2026', week = 8): WaiverSignals => ({
  season, week, source: 'Test source', updatedAt: '2026-10-27T12:00:00.000Z',
  players: [{ playerId: '4034', weeks: [{ week, stats: { rec: 5, rec_yd: 65 }, bye: false }] }],
});
const provenance = (ingestedAt: string, season = '2026', week = 8): FeedProvenance => ({
  season, week, sourceName: 'Test source', sourceTimestamp: '2026-10-27T12:00:00.000Z', ingestedAt,
  licenses: [], contributions: [{ source: 'Test source', sourceTimestamp: '2026-10-27T12:00:00.000Z', role: 'projections' }],
});
const report = (): IngestionReport => ({
  season: '2026', week: 8, startedAt: '2026-10-27T12:00:00.000Z', finishedAt: '2026-10-27T12:00:01.000Z', durationMs: 1000,
  status: 'published', provenance: provenance('2026-10-27T12:00:01.000Z'), players: 1, omitted: { noProjection: 0 },
  identity: { total: 1, resolved: 1, rate: 1, byMethod: { 'cross-id': 1, 'team-defense': 0, 'name-team-position': 0, 'name-position': 0 } },
  unresolved: [], unresolvedTotal: 0, coverage: null, derivations: [], schema: { valid: true, error: null },
  scenarios: { supported: false, withFloor: 0, withCeiling: 0 }, errors: [], breaches: [],
});
const stored = (ingestedAt: string, season = '2026', week = 8): StoredFeed => ({ provenance: provenance(ingestedAt, season, week), feed: feed(season, week), report: report() });

test('a written feed round-trips and leaves no temporary file behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  const path = join(directory, 'nested', 'feed.json');
  const repository = new FileFeedRepository(path);
  await repository.write(stored('2026-10-27T12:00:01.000Z'));
  const read = await repository.read();
  assert.equal(read?.feed.players[0].playerId, '4034');
  assert.deepEqual((await readdir(join(directory, 'nested'))), ['feed.json']);
});

test('a missing feed reads as null rather than throwing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  assert.equal(await new FileFeedRepository(join(directory, 'absent.json')).read(), null);
});

test('a corrupted stored feed fails at the store rather than downstream at the scoring boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  const path = join(directory, 'feed.json');
  await writeFile(path, JSON.stringify({ provenance: provenance('2026-10-27T12:00:01.000Z'), feed: { season: '2026', week: 8 }, report: report() }));
  await assert.rejects(() => new FileFeedRepository(path).read(), /Invalid waiver signal metadata/);
});

test('concurrent writes serialize, and the file is always one complete feed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  const path = join(directory, 'feed.json');
  const repository = new FileFeedRepository(path);
  await Promise.all([8, 9, 10].map(week => repository.write(stored('2026-10-27T12:00:01.000Z', '2026', week))));
  const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredFeed;
  assert.ok([8, 9, 10].includes(parsed.feed.week));
  assert.deepEqual(await readdir(directory), ['feed.json']);
});

test('a feed inside the threshold loads; the same feed past it does not', async () => {
  const at = Date.parse('2026-10-27T12:00:00.000Z');
  const repository = new InMemoryFeedRepository(stored(new Date(at).toISOString()));
  const fresh = new ProjectionFeedStore(repository, DEFAULT_SERVICE_LEVEL, () => at + HOUR);
  assert.equal((await fresh.load('2026', 8))?.players.length, 1);

  const old = new ProjectionFeedStore(repository, DEFAULT_SERVICE_LEVEL, () => at + 13 * HOUR);
  assert.equal(await old.load('2026', 8), null, 'a stale feed is an explicit unavailable state, never a quiet answer');
});

test('a stale feed is retained and reported, not discarded', async () => {
  const at = Date.parse('2026-10-27T12:00:00.000Z');
  const store = new ProjectionFeedStore(new InMemoryFeedRepository(stored(new Date(at).toISOString())), DEFAULT_SERVICE_LEVEL, () => at + 20 * HOUR);
  const state = await store.state('2026', 8);
  assert.equal(state?.stale, true);
  assert.equal(state?.players, 1, 'the last good feed is still there to inspect');
  assert.match(state!.staleReason!, /20\.0h ago, past the 12\.0h staleness threshold/);
  assert.equal(state?.matchesRequest, true);
});

test('a feed for another week never answers this week\'s request', async () => {
  const at = Date.parse('2026-10-27T12:00:00.000Z');
  const store = new ProjectionFeedStore(new InMemoryFeedRepository(stored(new Date(at).toISOString(), '2026', 7)), DEFAULT_SERVICE_LEVEL, () => at);
  assert.equal(await store.load('2026', 8), null);
  assert.equal((await store.state('2026', 8))?.matchesRequest, false);
});

test('staleness is a function of the reading clock, not of a flag written at ingestion', () => {
  const at = '2026-10-27T12:00:00.000Z';
  assert.equal(stalenessOf(at, DEFAULT_SERVICE_LEVEL, Date.parse(at) + 2 * HOUR).stale, false);
  assert.equal(stalenessOf(at, DEFAULT_SERVICE_LEVEL, Date.parse(at) + 24 * HOUR).stale, true);
  assert.equal(stalenessOf('not a date').stale, true);
});
