import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SleeperClient } from '@sleeper/sleeper-client';
import { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';

test('synchronization is locked, normalized, immutable, and caches player metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sync-')); const store = new JsonStore(join(dir, 'data.json')); let leagueCalls = 0; let playerCalls = 0;
  const client = {
    league: async (id: string) => { leagueCalls++; await new Promise(resolve => setTimeout(resolve, 10)); return { league_id: id, name: 'League', season: '2026', status: 'in_season', roster_positions: ['QB'], settings: { leg: 2 } }; },
    rosters: async () => [{ roster_id: 1, owner_id: 'user-1', players: ['p1'], starters: ['p1'], settings: { wins: 1 } }],
    matchups: async () => [{ roster_id: 1, matchup_id: 1, players: ['p1'], starters: ['p1'], points: 10 }],
    transactions: async () => [{ transaction_id: 'tx1', type: 'waiver', status: 'complete', roster_ids: [1], adds: { p1: 1 }, drops: null, created: 1_700_000_000_000 }],
    tradedPicks: async () => [{ season: '2027', round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 1 }],
    userById: async () => ({ user_id: 'user-1', username: 'private-handle', display_name: 'Manager', avatar: null }),
    nflPlayers: async () => { playerCalls++; return { p1: { player_id: 'p1', full_name: 'Player One', position: 'QB', active: true } }; }
  } as unknown as SleeperClient;
  const messages: Array<Record<string, unknown>> = []; const log = { info: (fields: Record<string, unknown>) => messages.push(fields), error: () => undefined };
  const service = new LeagueSyncService(store, client, log);
  await Promise.all([service.sync('league-1'), service.sync('league-1')]);
  assert.equal(leagueCalls, 1); assert.equal(playerCalls, 1);
  const first = await store.data(); const snapshot = Object.values(first.weeklySnapshots)[0]; assert.equal(snapshot.roster.playerIds[0], 'p1');
  await service.sync('league-1'); const second = await store.data();
  assert.equal(playerCalls, 1); assert.equal(Object.keys(second.weeklySnapshots).length, 1); assert.equal(second.weeklySnapshots[snapshot.id].syncedAt, snapshot.syncedAt);
  assert.equal(messages.some(entry => Object.values(entry).includes('private-handle')), false);
});
