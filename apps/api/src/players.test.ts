import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { SleeperApiError } from '@sleeper/sleeper-client';
import { PlayerDirectoryService, PLAYER_REFRESH_MS, PLAYER_RETRY_MS, normalizePlayers } from './players.js';
import { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';
import { createApp } from './app.js';
import { signedInAs } from './test-support/auth.js';

const raw = {
  p1: { player_id: 'p1', first_name: ' Player ', last_name: 'One', position: 'QB', fantasy_positions: ['QB', 'QB'], status: 'Active', injury_status: 'Questionable' },
  old: { player_id: 'old', full_name: 'Retired Player', status: 'Retired' },
  free: { player_id: 'free', full_name: 'Free Agent', status: 'Active' },
};
const league = (id = 'l1') => ({ league_id: id, name: 'League', season: '2026', status: 'in_season', roster_positions: ['QB'], settings: {} });
const client = {
  league: async (id: string) => league(id), leagueUsers: async () => [],
  rosters: async () => [{ roster_id: 1, owner_id: 'u1', players: ['p1', 'missing'], starters: ['p1', '0'], reserve: ['old'], taxi: ['taxi'], settings: {} }],
  matchups: async () => [{ matchup_id: 1, roster_id: 1, points: 0, players: ['historic'], starters: ['historic'], players_points: { scored: 1 } }],
  transactions: async () => [{ transaction_id: 't1', type: 'waiver', status: 'complete', roster_ids: [1], adds: { added: 1 }, drops: { dropped: 1 }, draft_picks: [] }],
  tradedPicks: async () => [], drafts: async () => [], players: async () => raw,
};
async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'players-')), 'store.json');
  return { store: new JsonStore(path), path };
}

test('validates the entire directory before publication and normalizes only whitelisted fields', () => {
  const players = normalizePlayers(raw, '2026-09-10T00:00:00Z');
  assert.equal(players[0].fullName, 'Player One');
  assert.deepEqual(players[0].fantasyPositions, ['QB']);
  assert.equal(players[0].injuryStatus, 'Questionable');
  for (const bad of [null, [], {}, { p1: [] }, { p1: { ...raw.p1, player_id: 'other' } }, { p1: { ...raw.p1, full_name: {} } }, { p1: { ...raw.p1, fantasy_positions: [3] } }, { p1: { ...raw.p1, status: true } }]) {
    assert.throws(() => normalizePlayers(bad, '2026-09-10T00:00:00Z'), /Invalid NFL/);
  }
});

test('global refresh coalesces across leagues, ignores force, persists across restart and expires daily', async () => {
  const { store, path } = await fixture();
  let calls = 0, clock = new Date('2026-09-10T00:00:00Z');
  const upstream = { ...client, players: async () => { calls++; return raw; } };
  const sync = new LeagueSyncService(store, upstream as never, undefined, () => clock);
  await Promise.all([sync.syncLeague('l1', 1, true), sync.syncLeague('l2', 1, true)]);
  assert.equal(calls, 1);
  await sync.syncLeague('l1', 1, true);
  assert.equal(calls, 1, 'force is only for league resources');
  const restarted = new PlayerDirectoryService(new JsonStore(path), upstream as never, () => clock);
  assert.equal(await restarted.refresh(), false);
  assert.equal((await restarted.subset({ ids: ['p1'] })).players.p1.full_name, 'Player One');
  clock = new Date(clock.getTime() + PLAYER_REFRESH_MS);
  assert.equal(await restarted.refresh(), true);
  assert.equal(calls, 2);
});

test('upstream errors and malformed/empty data retain the last good dataset and back off through restarts', async () => {
  const { store, path } = await fixture();
  let clock = new Date('2026-09-10T00:00:00Z'), payload: unknown = raw, failure: Error | undefined, calls = 0;
  const upstream = { players: async () => { calls++; if (failure) throw failure; return payload; } };
  const directory = new PlayerDirectoryService(store, upstream as never, () => clock);
  await directory.refresh();
  const first = await directory.subset({ ids: ['p1'] });
  for (const bad of [new SleeperApiError(429, 'Rate limited', 'rate_limit', true, 2 * PLAYER_RETRY_MS), {}, { ...raw, free: { player_id: 'free', status: 5 } }]) {
    clock = new Date(clock.getTime() + PLAYER_REFRESH_MS);
    failure = bad instanceof Error ? bad : undefined; payload = bad;
    assert.equal(await directory.refresh(), false);
    const retained = await directory.subset({ ids: ['p1'] });
    assert.deepEqual(retained.players, first.players);
    assert.equal(retained.playerMetadata.synchronizedAt, first.playerMetadata.synchronizedAt);
    assert.equal(retained.playerMetadata.stale, true);
    assert.match(retained.playerError!, /last good/);
    assert.equal(Date.parse(retained.playerMetadata.nextAttemptAt!), clock.getTime() + (failure ? 2 * PLAYER_RETRY_MS : PLAYER_RETRY_MS));
    const before = calls;
    await new PlayerDirectoryService(new JsonStore(path), upstream as never, () => clock).refresh();
    assert.equal(calls, before);
  }
  failure = undefined; payload = { ...raw, p1: { ...raw.p1, injury_status: null } };
  clock = new Date(clock.getTime() + PLAYER_RETRY_MS);
  await directory.refresh();
  const recovered = await directory.subset({ ids: ['p1'] });
  assert.equal(recovered.playerMetadata.lastError, null);
  assert.equal(recovered.playerMetadata.stale, false);
  assert.equal(recovered.playerError, undefined);
  assert.equal(recovered.players.p1.injury_status, null);
});

test('player feed failure does not fail a league sync, including first use', async () => {
  const { store } = await fixture();
  const upstream = { ...client, players: async () => { throw new Error('Offline'); } };
  const sync = new LeagueSyncService(store, upstream as never);
  const result = await sync.syncLeague('l1', 1);
  assert.ok(result.snapshotId);
  assert.equal((await store.rosters('l1')).length, 1);
  const unavailable = await new PlayerDirectoryService(store).subset({ ids: ['p1', '0'] });
  assert.equal(unavailable.playerMetadata.synchronizedAt, null);
  assert.deepEqual(unavailable.playerMetadata.unknownPlayerIds, ['p1']);
  assert.equal(unavailable.players.p1.full_name, 'Player p1');
});

test('removed IDs become unknown on a successful replacement and retired IDs remain renderable', async () => {
  const { store } = await fixture();
  let clock = new Date('2026-09-10T00:00:00Z'), payload: unknown = raw;
  const directory = new PlayerDirectoryService(store, { players: async () => payload } as never, () => clock);
  await directory.refresh();
  payload = { old: raw.old, free: raw.free };
  clock = new Date(clock.getTime() + PLAYER_REFRESH_MS);
  await directory.refresh();
  const subset = await directory.subset({ ids: ['p1', 'old', '0', 'old'] });
  assert.deepEqual(subset.playerMetadata.unknownPlayerIds, ['p1']);
  assert.deepEqual(subset.playerMetadata.retiredPlayerIds, ['old']);
  assert.equal(subset.players.old.full_name, 'Retired Player');
  assert.deepEqual(Object.keys(subset.players), ['old', 'p1']);
  assert.equal((await store.allPlayers()).length, 2);
});

test('existing stores keep their successful timestamp while upgrading through an upstream failure', async () => {
  const { store } = await fixture();
  const at = '2026-09-09T00:00:00.000Z';
  await store.applySync({ players: normalizePlayers(raw, at), freshness: { 'players:nfl': at } });
  const directory = new PlayerDirectoryService(store, { players: async () => { throw new Error('Offline'); } } as never, () => new Date('2026-09-10T00:00:00Z'));
  await directory.refresh();
  const result = await directory.subset({ ids: ['p1'] });
  assert.equal(result.playerMetadata.synchronizedAt, at);
  assert.equal(result.players.p1.full_name, 'Player One');
  assert.match(result.playerError!, /last good/);
});

test('slow player refreshes do not hold API reads behind upstream timeouts', async () => {
  const { store } = await fixture();
  let finish!: (value: typeof raw) => void;
  const pending = new Promise<typeof raw>(resolve => { finish = resolve; });
  let clock = new Date('2026-09-10T00:00:00Z');
  const directory = new PlayerDirectoryService(store, { players: () => pending } as never, () => clock);
  // Cold start returns safe placeholders even while the upstream request remains unresolved.
  await directory.prepareRead();
  assert.equal((await directory.subset({ ids: ['p1'] })).players.p1.metadataStatus, 'unknown');
  finish(raw);
  await directory.refresh();
  clock = new Date(clock.getTime() + PLAYER_REFRESH_MS);
  let complete!: (value: typeof raw) => void;
  const slow = new PlayerDirectoryService(store, { players: () => new Promise(resolve => { complete = resolve; }) } as never, () => clock);
  await slow.prepareRead();
  assert.equal((await slow.subset({ ids: ['p1'] })).players.p1.full_name, 'Player One');
  // Wait until the background fetch has entered, without requiring it to finish before rendering.
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  complete(raw);
  await slow.refresh();
});

test('league HTTP responses remain usable when player ingestion fails on cold start or after expiry', async () => {
  const { store } = await fixture();
  const upstream = { ...client, players: async () => { throw new Error('Offline'); } };
  const app = createApp(store, upstream as never);
  const session = await signedInAs(store, { sleeperUserId: 'u1', leagueIds: ['l1'] });
  const get = () => request(app).get('/api/sleeper/leagues/l1?week=1').set('Cookie', session.cookie);
  const cold = await get();
  assert.equal(cold.status, 200);
  assert.equal(cold.body.league.league_id, 'l1');
  assert.equal(cold.body.playerMetadata.synchronizedAt, null);
  assert.equal(cold.body.players.p1.metadataStatus, 'unknown');
  const at = new Date(Date.now() - 2 * PLAYER_REFRESH_MS).toISOString();
  await store.savePlayerDirectory({ synchronizedAt: at, lastAttemptedAt: at, nextAttemptAt: at, lastError: null }, normalizePlayers(raw, at));
  const warm = await get();
  assert.equal(warm.status, 200);
  assert.equal(warm.body.playerMetadata.synchronizedAt, at);
  assert.equal(warm.body.players.p1.full_name, 'Player One');
  assert.match(warm.body.playerError, /last good/);
});

test('league responses include only relevant IDs and player lookup supports private ETag revalidation', async () => {
  const { store } = await fixture();
  let calls = 0;
  const app = createApp(store, { ...client, players: async () => { calls++; return raw; } } as never);
  const session = await signedInAs(store, { sleeperUserId: 'u1', leagueIds: ['l1'] });
  const get = (path: string) => request(app).get(path).set('Cookie', session.cookie);
  assert.equal((await request(app).get('/api/players/l1?ids=p1')).status, 401);
  assert.equal((await get('/api/players/l2?ids=p1')).status, 403);
  assert.equal(calls, 0);
  const detail = await get('/api/sleeper/leagues/l1?week=1');
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(detail.body.players), ['added', 'dropped', 'historic', 'missing', 'old', 'p1', 'scored', 'taxi']);
  assert.ok(detail.body.playerMetadata.synchronizedAt);
  assert.equal(detail.body.players.free, undefined);
  assert.equal(detail.body.players.old.metadataStatus, 'retired');
  assert.match(detail.headers['cache-control'], /private/);
  const subset = await get('/api/players/l1?ids=free,p1');
  assert.equal(subset.status, 200);
  assert.deepEqual(Object.keys(subset.body.players), ['free', 'p1']);
  assert.ok(subset.headers.etag);
  assert.match(subset.headers.vary, /Cookie/);
  const cached = await get('/api/players/l1?ids=free,p1').set('If-None-Match', subset.headers.etag);
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
  const persisted = (await store.playerDirectory()).metadata!;
  await store.savePlayerDirectory(persisted, normalizePlayers({ ...raw, p1: { ...raw.p1, injury_status: 'Out' } }, persisted.synchronizedAt!));
  const changed = await get('/api/players/l1?ids=free,p1').set('If-None-Match', subset.headers.etag);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, subset.headers.etag);
  assert.equal(changed.body.players.p1.injury_status, 'Out');
  const search = await get('/api/players/l1?q=player&limit=1');
  assert.equal(search.status, 200);
  assert.equal(Object.keys(search.body.players).length, 1);
  assert.deepEqual((await get('/api/players/l1?q=nomatch')).body.players, {});
  assert.deepEqual((await get('/api/players/l1')).body.players, {}, 'no selector cannot dump the directory');
  for (const query of ['ids=', 'ids=p1&q=player', 'q=p', 'q=player&limit=51', `ids=${Array(101).fill('p1').join(',')}`]) assert.equal((await get(`/api/players/l1?${query}`)).status, 400);
  assert.equal(calls, 1);
  assert.equal((await request(app).get('/api/players/l1?ids=free,p1').set('If-None-Match', subset.headers.etag)).status, 401);
});
