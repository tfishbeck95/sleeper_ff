import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';

const client = {
  league: async () => ({ league_id: 'l1', name: 'League', season: '2026', status: 'in_season', roster_positions: ['QB'], settings: {} }),
  leagueUsers: async () => [], rosters: async () => [{ roster_id: 1, owner_id: 'u1', players: ['p1'], starters: ['p1'], settings: {} }],
  matchups: async () => [{ matchup_id: 1, roster_id: 1, points: 12, players: ['p1'], starters: ['p1'] }], transactions: async () => [], tradedPicks: async () => [],
  players: async () => ({ p1: { player_id: 'p1', full_name: 'Player One', position: 'QB' } })
};
test('coalesces league jobs and stores an immutable weekly observation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-')); const path = join(dir, 'store.json'); const service = new LeagueSyncService(new JsonStore(path), client as never);
  const [first, second] = await Promise.all([service.syncLeague('l1', 1), service.syncLeague('l1', 1)]);
  assert.equal(first.snapshotId, second.snapshotId);
  const stored = JSON.parse(await readFile(path, 'utf8')) as { weeklySnapshots: unknown[]; players: Record<string, unknown> };
  assert.equal(stored.weeklySnapshots.length, 1); assert.ok(stored.players.p1);
});

test('pick synchronization replaces reordered/removed transfers and retains other leagues', async () => {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'pick-sync-')), 'store.json'));
  let picks = [{ season: '2027', round: 1, roster_id: 1, owner_id: 2 }, { season: '2027', round: 2, roster_id: 1, owner_id: 2 }];
  const service = new LeagueSyncService(store, { ...client, tradedPicks: async () => picks } as never);
  assert.equal((await store.tradeContext('l1')).tradedPicks, undefined, 'never-synced transfers are unknown');
  await service.syncLeague('l1', 1, true);
  assert.equal((await store.tradeContext('l1')).tradedPicks!.length, 2);
  const foreign = { ...(await store.tradeContext('l1')).tradedPicks![0], id: 'foreign', leagueId: 'l2' };
  await store.applySync({ draftPicks: [foreign], freshness: { 'draftPicks:l2': new Date().toISOString() } });
  picks = [{ ...picks[1], owner_id: 1 }];
  await service.syncLeague('l1', 1, true);
  const updated = (await store.tradeContext('l1')).tradedPicks!;
  assert.equal(updated.length, 1); assert.equal(updated[0].round, 2); assert.equal(updated[0].ownerId, 1);
  picks = []; await service.syncLeague('l1', 1, true);
  assert.deepEqual((await store.tradeContext('l1')).tradedPicks, []);
  assert.equal((await store.tradeContext('l2')).tradedPicks!.length, 1);
});
