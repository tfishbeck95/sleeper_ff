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
