import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { JsonStore } from './store.js';
import { signedInAs } from './test-support/auth.js';

// These suites exercise the sample league routes, which production never serves.
process.env.ENABLE_DEMO_AUTH = 'true';
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
  return { app, store, calls: () => calls };
}
/** Each call signs in as a distinct application user, so ownership is decided by the session alone. */
const auth = async (app: ReturnType<typeof createApp>, path: string, store: JsonStore, sleeperUserId = 'sample') => request(app).get(path).set('Cookie', (await signedInAs(store, { sleeperUserId, leagueIds: ['1234', 'demo'] })).cookie);
test('trade API authenticates, validates bounds before sync and scopes owner/co-owner', async () => {
  const { app, calls, store } = await fixture();
  assert.equal((await request(app).get('/api/trades/1234?week=8')).status, 401);
  for (const query of ['week=0', 'week=8&week=9', 'week=8&maxRisk=NaN', 'week=8&maxResults=999', 'week=8&maxValueGap=-1', 'week=8&unknown=1']) assert.equal((await auth(app, `/api/trades/1234?${query}`, store)).status, 400, query);
  assert.equal(calls(), 0);
  const owner = await auth(app, '/api/trades/1234?week=8&maxValueGap=0', store);
  assert.equal(owner.status, 200); assert.equal(owner.body.rosterId, 1); assert.ok(owner.body.candidates.length); assert.ok(owner.body.candidates.every((c: { valueGap: number }) => c.valueGap === 0));
  assert.equal((await auth(app, '/api/trades/1234?week=8', store, 'coowner')).body.rosterId, 1);
  assert.equal((await auth(app, '/api/trades/1234?week=8', store, 'stranger')).status, 403);
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['1234'] });
  assert.equal((await request(app).post('/api/trades/1234').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken)).status, 404);
});
test('missing provider returns unavailable without private errors; sample is explicit in both formats', async () => {
  const { app, store } = await fixture({ load: async () => { throw new Error('/private/provider.json failed'); } });
  const live = await auth(app, '/api/trades/1234?week=8', store);
  assert.equal(live.status, 200); assert.equal(live.body.status, 'unavailable'); assert.deepEqual(live.body.candidates, []);
  assert.doesNotMatch(JSON.stringify(live.body), /private\/provider|Fictional/);
  for (const format of ['redraft', 'dynasty']) {
    const demo = await auth(app, `/api/trades/demo?format=${format}`, store);
    assert.equal(demo.status, 200); assert.equal(demo.body.format, format); assert.deepEqual(demo.body.candidates, []); assert.equal(demo.body.scoring.kind, 'partial-reference');
  }
});
