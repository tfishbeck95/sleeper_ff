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
import { demoWaiverInput } from './test-support/scoring-fixtures.js';
import type { WaiverSignalProvider } from './waiver-signals.js';

async function appFixture(provider?: WaiverSignalProvider) {
  const input = demoWaiverInput(); input.league.id = '1234'; input.rosters.forEach(r => { r.leagueId = '1234'; r.id = `1234:${r.rosterId}`; });
  input.rosters[0].coOwnerIds = ['coowner'];
  const dir = await mkdtemp(join(tmpdir(), 'waiver-api-')); const store = new JsonStore(join(dir, 'data.json'));
  await store.applySync({ league: input.league, rosters: input.rosters, players: input.players });
  let calls = 0;
  const app = createApp(store, undefined, { syncLeague: async () => { calls += 1; } } as never, provider ?? { load: async () => input.signals });
  return { app, store, calls: () => calls };
}
/** Each call signs in as a distinct application user, so ownership is decided by the session alone. */
const auth = async (app: ReturnType<typeof createApp>, path: string, store: JsonStore, sleeperUserId = 'sample') => request(app).get(path).set('Cookie', (await signedInAs(store, { sleeperUserId, leagueIds: ['1234', 'demo'] })).cookie);

test('waiver route authenticates, validates before sync, and selects owners/co-owners', async () => {
  const { app, calls, store } = await appFixture();
  assert.equal((await request(app).get('/api/waivers/1234?week=8')).status, 401);
  for (const query of ['week=0', 'week=1.5', 'week=19']) assert.equal((await auth(app, `/api/waivers/1234?${query}`, store)).status, 400);
  assert.equal(calls(), 0);
  const owner = await auth(app, '/api/waivers/1234?week=8', store);
  assert.equal(owner.status, 200); assert.equal(owner.body.rosterId, 1); assert.ok(owner.body.recommendations.length);
  const coowner = await auth(app, '/api/waivers/1234?week=8', store, 'coowner');
  assert.equal(coowner.body.rosterId, 1);
  assert.equal((await auth(app, '/api/waivers/1234?week=8', store, 'stranger')).status, 403);
  assert.equal(owner.body.submission.supported, false); assert.equal(owner.body.submission.url, 'https://sleeper.com/leagues/1234');
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['1234'] });
  assert.equal((await request(app).post('/api/waivers/1234').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken)).status, 404);
});

test('provider failures return unavailable analysis without sample leakage, demo is explicit', async () => {
  const { app, store } = await appFixture({ load: async () => { throw new Error('private/path/provider.json failed'); } });
  const result = await auth(app, '/api/waivers/1234?week=8', store);
  assert.equal(result.status, 200); assert.equal(result.body.status, 'unavailable');
  assert.deepEqual(result.body.recommendations, []); assert.doesNotMatch(JSON.stringify(result.body), /private\/path/);
  const demo = await auth(app, '/api/waivers/demo', store);
  assert.equal(demo.body.status, 'unavailable'); assert.deepEqual(demo.body.recommendations, []); assert.equal(demo.body.scoring.kind, 'partial-reference'); assert.equal(demo.body.submission.url, null);
});
