import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { JsonStore } from './store.js';
import { demoLineupInput } from './test-support/scoring-fixtures.js';
import type { WaiverSignalProvider } from './waiver-signals.js';

async function appFixture(provider?: WaiverSignalProvider) {
  const input = demoLineupInput();
  input.league.id = '1234';
  input.rosters.forEach(r => { r.leagueId = '1234'; r.id = `1234:${r.rosterId}`; });
  input.rosters[0].coOwnerIds = ['coowner'];
  const matchups = input.matchups!.map(m => ({ ...m, leagueId: '1234', id: `1234:${m.season}:${m.week}:${m.rosterId}` }));
  const dir = await mkdtemp(join(tmpdir(), 'lineup-api-')); const store = new JsonStore(join(dir, 'data.json'));
  await store.applySync({ league: input.league, rosters: input.rosters, players: input.players, matchups });
  let calls = 0;
  const app = createApp(store, undefined, { syncLeague: async () => { calls += 1; } } as never, provider ?? { load: async () => input.signals });
  return { app, calls: () => calls };
}
const auth = (app: ReturnType<typeof createApp>, path: string) => request(app).get(path).set('Authorization', 'Bearer demo-token');

test('lineup route authenticates, validates before sync, and selects owners/co-owners', async () => {
  const { app, calls } = await appFixture();
  assert.equal((await request(app).get('/api/lineup/1234?week=8&userId=sample')).status, 401);
  for (const query of ['week=0&userId=sample', 'week=1.5&userId=sample', 'week=19&userId=sample', 'week=8', 'week=8&userId=a&userId=b']) assert.equal((await auth(app, `/api/lineup/1234?${query}`)).status, 400);
  assert.equal(calls(), 0);
  const owner = await auth(app, '/api/lineup/1234?week=8&userId=sample');
  assert.equal(owner.status, 200); assert.equal(owner.body.rosterId, 1);
  assert.equal(owner.body.scoringLabel, 'full-PPR');
  assert.ok(owner.body.scoringSnapshotId.startsWith('complete-live:'));
  assert.ok(owner.body.startSit.length);
  assert.equal(owner.body.matchup.opponentRosterId, 2);
  assert.ok(owner.body.lineup.every((slot: { explanation: string }) => slot.explanation.length > 10));
  assert.equal((await auth(app, '/api/lineup/1234?week=8&userId=coowner')).body.rosterId, 1);
  assert.equal((await auth(app, '/api/lineup/1234?week=8&userId=stranger')).status, 403);
});

test('provider failures return unavailable analysis without leaking paths, and demo stays explicit', async () => {
  const { app } = await appFixture({ load: async () => { throw new Error('private/path/provider.json failed'); } });
  const result = await auth(app, '/api/lineup/1234?week=8&userId=sample');
  assert.equal(result.status, 200); assert.equal(result.body.status, 'unavailable');
  assert.deepEqual(result.body.startSit, []); assert.doesNotMatch(JSON.stringify(result.body), /private\/path/);
  const demo = await auth(app, '/api/lineup/demo');
  assert.equal(demo.body.status, 'unavailable');
  assert.equal(demo.body.scoring.kind, 'partial-reference');
  assert.deepEqual(demo.body.lineup, []); assert.equal(demo.body.matchup, null);
});
