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

test('synchronization persists full scoring, reports differences, disables after failure and recovers', async () => {
  const { EXPECTED_SCORING } = await import('@sleeper/domain');
  const path = join(await mkdtemp(join(tmpdir(), 'scoring-sync-')), 'store.json');
  const store = new JsonStore(path);
  let raw: Record<string, unknown> | undefined = { ...EXPECTED_SCORING, bonus_rec_te: .5, pts_allow_35p: -4 };
  let fail = false, clock = new Date('2026-09-08T12:00:00Z'), calls = 0;
  const service = new LeagueSyncService(store, { ...client, league: async () => { calls++; if (fail) throw new Error('Offline'); return { ...await client.league(), scoring_settings: raw }; } } as never, undefined, () => clock);
  const first = await service.syncLeague('l1', 1);
  assert.equal(first.scoring.kind, 'complete-live'); assert.deepEqual(first.scoring.settings, raw);
  let saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.leagues.l1.scoring.rawSettings, raw);
  assert.deepEqual(saved.weeklySnapshots[0].scoring.settings, raw);
  clock = new Date('2026-09-08T12:01:00Z'); fail = true;
  await assert.rejects(service.syncLeague('l1', 1), /Offline/);
  const failed = (await store.league('l1'))!.scoring!;
  assert.equal(failed.kind, 'unavailable'); assert.deepEqual(failed.rawSettings, raw);
  assert.equal(failed.synchronizedAt, first.scoring.synchronizedAt); assert.equal(failed.lastAttemptedAt, clock.toISOString());
  assert.equal(calls, 2, 'scoring is refreshed even inside the metadata cache interval');
  saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.weeklySnapshots[0].scoring.kind, 'complete-live', 'historical observation remains immutable');
  fail = false; raw = { ...EXPECTED_SCORING, rec: .5 }; delete raw.pass_td;
  const invalid = await service.syncLeague('l1', 1, true);
  assert.equal(invalid.scoring.kind, 'unavailable');
  assert.ok(invalid.scoring.issues.some(i => i.kind === 'missing' && i.key === 'pass_td'));
  assert.ok(invalid.scoring.issues.some(i => i.kind === 'mismatched' && i.key === 'rec'));
  raw = undefined;
  assert.equal((await service.syncLeague('l1', 1)).scoring.kind, 'unavailable');
  raw = { ...EXPECTED_SCORING, additional: 0 };
  const recovered = await service.syncLeague('l1', 1);
  assert.equal(recovered.scoring.kind, 'complete-live'); assert.equal(recovered.scoring.synchronizedAt, clock.toISOString());
});
