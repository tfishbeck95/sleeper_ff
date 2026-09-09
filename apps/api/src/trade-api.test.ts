import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { JsonStore } from './store.js';
import { demoTradeInput } from './test-support/scoring-fixtures.js';
import type { WaiverSignalProvider } from './waiver-signals.js';

async function fixture(provider?: WaiverSignalProvider) {
  const input = demoTradeInput(); input.league.id = '1234';
  input.rosters.forEach(r => { r.leagueId = '1234'; r.id = `1234:${r.rosterId}`; });
  input.rosters[0].coOwnerIds = ['coowner'];
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'trade-api-')), 'data.json'));
  await store.applySync({ league: input.league, rosters: input.rosters, players: input.players });
  let calls = 0;
  const app = createApp(store, undefined, { syncLeague: async () => { calls++; } } as never, provider ?? { load: async () => input.signals });
  return { app, calls: () => calls };
}
const auth = (app: ReturnType<typeof createApp>, path: string) => request(app).get(path).set('Authorization', 'Bearer demo-token');
test('trade API authenticates, validates bounds before sync and scopes owner/co-owner', async () => {
  const { app, calls } = await fixture();
  assert.equal((await request(app).get('/api/trades/1234?week=8&userId=sample')).status, 401);
  for (const query of ['week=8', 'week=0&userId=sample', 'week=8&week=9&userId=sample', 'week=8&userId=x&userId=y', 'week=8&userId=sample&maxRisk=NaN', 'week=8&userId=sample&maxResults=999', 'week=8&userId=sample&maxValueGap=-1', 'week=8&userId=sample&unknown=1']) assert.equal((await auth(app, `/api/trades/1234?${query}`)).status, 400, query);
  assert.equal(calls(), 0);
  const owner = await auth(app, '/api/trades/1234?week=8&userId=sample&maxValueGap=0');
  assert.equal(owner.status, 200); assert.equal(owner.body.rosterId, 1); assert.ok(owner.body.candidates.length); assert.ok(owner.body.candidates.every((c: { valueGap: number }) => c.valueGap === 0));
  assert.equal((await auth(app, '/api/trades/1234?week=8&userId=coowner')).body.rosterId, 1);
  assert.equal((await auth(app, '/api/trades/1234?week=8&userId=stranger')).status, 403);
  assert.equal((await request(app).post('/api/trades/1234').set('Authorization', 'Bearer demo-token')).status, 404);
});
test('missing provider returns unavailable without private errors; sample is explicit in both formats', async () => {
  const { app } = await fixture({ load: async () => { throw new Error('/private/provider.json failed'); } });
  const live = await auth(app, '/api/trades/1234?week=8&userId=sample');
  assert.equal(live.status, 200); assert.equal(live.body.status, 'unavailable'); assert.deepEqual(live.body.candidates, []);
  assert.doesNotMatch(JSON.stringify(live.body), /private\/provider|Fictional/);
  for (const format of ['redraft', 'dynasty']) {
    const demo = await auth(app, `/api/trades/demo?format=${format}`);
    assert.equal(demo.status, 200); assert.equal(demo.body.format, format); assert.deepEqual(demo.body.candidates, []); assert.equal(demo.body.scoring.kind, 'partial-reference');
  }
});
