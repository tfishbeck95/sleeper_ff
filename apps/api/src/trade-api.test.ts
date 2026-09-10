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
const auth = async (app: ReturnType<typeof createApp>, path: string) => { process.env.ENABLE_DEMO_AUTH='true'; process.env.DEMO_SLEEPER_LEAGUE_IDS='demo,1234'; const login=await request(app).post('/auth/demo'); return request(app).get(path).set('Cookie',login.headers['set-cookie'][0].split(';')[0]); };
test('trade API authenticates, validates bounds before sync and scopes owner/co-owner', async () => {
  const { app, calls } = await fixture();
  assert.equal((await request(app).get('/api/trades/1234?week=8')).status, 401);
  for (const query of ['week=0', 'week=8&week=9', 'week=8&maxRisk=NaN', 'week=8&maxResults=999', 'week=8&maxValueGap=-1', 'week=8&unknown=1']) assert.equal((await auth(app, `/api/trades/1234?${query}`)).status, 400, query);
  assert.equal(calls(), 0);
  const owner = await auth(app, '/api/trades/1234?week=8&maxValueGap=0');
  assert.equal(owner.status, 200); assert.equal(owner.body.rosterId, 1); assert.ok(owner.body.candidates.length); assert.ok(owner.body.candidates.every((c: { valueGap: number }) => c.valueGap === 0));
  assert.equal((await auth(app, '/api/trades/1234?week=8')).body.rosterId, 1);
  assert.equal((await auth(app, '/api/trades/1234?week=8&userId=stranger')).status, 400);
  assert.equal((await request(app).post('/api/trades/1234')).status, 401);
});
test('missing provider returns unavailable without private errors; sample is explicit in both formats', async () => {
  const { app } = await fixture({ load: async () => { throw new Error('/private/provider.json failed'); } });
  const live = await auth(app, '/api/trades/1234?week=8');
  assert.equal(live.status, 200); assert.equal(live.body.status, 'unavailable'); assert.deepEqual(live.body.candidates, []);
  assert.doesNotMatch(JSON.stringify(live.body), /private\/provider|Fictional/);
  for (const format of ['redraft', 'dynasty']) {
    const demo = await auth(app, `/api/trades/demo?format=${format}`);
    assert.equal(demo.status, 200); assert.equal(demo.body.format, format); assert.deepEqual(demo.body.candidates, []); assert.equal(demo.body.scoring.kind, 'partial-reference');
  }
});
