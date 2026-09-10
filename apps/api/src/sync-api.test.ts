import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { League } from '@sleeper/domain';
import { SleeperApiError } from '@sleeper/sleeper-client';
import { createApp } from './app.js';
import { JsonStore } from './store.js';
import { resetRateLimits } from './rate-limit.js';
import { LeagueSyncWorker } from './scheduler/index.js';
import type { SyncResult } from './sync.js';
import { signedInAs } from './test-support/auth.js';

// The sample-league branch of these routes is development-only, and is exercised as such.
process.env.ENABLE_DEMO_AUTH = 'true';

const ENV = { NFL_SEASON: '2026', NFL_WEEK_ONE_TUESDAY: '2026-09-08T00:00:00Z' } as NodeJS.ProcessEnv;
const NOW = new Date('2026-10-06T12:00:00Z'); // Week 5 of the 2026 season.
const league = (id: string): League => ({
  id, name: `League ${id}`, season: '2026', status: 'in_season', previousLeagueId: null, totalRosters: 12,
  rosterPositions: [], scoringSettings: [], settings: { leg: 5 }, sourceUpdatedAt: null, synchronizedAt: NOW.toISOString(),
});

async function fixture(behavior: (leagueId: string, week: number) => Promise<void> | void = () => {}) {
  resetRateLimits();
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'sync-api-')), 'data.json'));
  await store.applySync({ league: league('1234'), freshness: { 'league:1234': NOW.toISOString() } });
  const calls: Array<{ leagueId: string; week: number; force: boolean }> = [];
  const sync = {
    async syncLeague(leagueId: string, week: number, force = false): Promise<SyncResult> {
      calls.push({ leagueId, week, force });
      await behavior(leagueId, week);
      return { leagueId, synchronizedAt: NOW.toISOString(), refreshed: ['league', 'rosters'], scoring: { kind: 'complete-live' } as never };
    },
  };
  const worker = new LeagueSyncWorker(store, sync, { logger: { info: () => {}, error: () => {} }, env: ENV, now: () => NOW, random: () => 0, sleep: async () => {}, jitterMs: 0, runOnStart: false });
  const app = createApp(store, undefined, sync as never, { load: async () => null } as never, worker);
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['1234', 'demo'] });
  return { app, store, worker, calls, session };
}
const refresh = (app: ReturnType<typeof createApp>, session: { cookie: string; csrfToken: string }, path: string) =>
  request(app).post(path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken);
/** The worker reaches Sleeper after the response has been sent, so "it started" is waited for. */
async function waitFor(until: () => boolean, attempts = 200) {
  for (let attempt = 0; attempt < attempts && !until(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  for (let tick = 0; tick < 10; tick += 1) await new Promise(resolve => setImmediate(resolve));
}

test('a manual refresh queues the scheduled job and answers without waiting for Sleeper', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { app, store, worker, calls, session } = await fixture(async () => { await gate; });

  const queued = await refresh(app, session, '/api/sync/1234?week=5');
  assert.equal(queued.status, 202, 'the request returns while the synchronization is still in flight');
  assert.equal(queued.body.queued, true);
  assert.equal(queued.body.leagueId, '1234');
  assert.equal(queued.body.lastSyncedAt, null, 'nothing has been synchronized yet, and the response says so');
  await waitFor(() => calls.length > 0);
  assert.equal(calls.length, 1, 'the worker performs the synchronization after the response has gone back');

  // A second press while the first is still running joins it rather than queueing another fan-out.
  const again = await refresh(app, session, '/api/sync/1234');
  assert.equal(again.status, 202);
  await waitFor(() => calls.length > 1, 20);
  assert.equal(calls.length, 1);

  release();
  await worker.drain();
  assert.equal((await store.leagueConnection('1234'))!.lastStatus, 'success');

  const state = await request(app).get('/api/sync/1234').set('Cookie', session.cookie);
  assert.equal(state.status, 200);
  assert.equal(state.body.queued, false);
  assert.equal(state.body.running, false);
  assert.equal(state.body.season, '2026');
  assert.equal(state.body.week, 5);
  assert.equal(state.body.lastStatus, 'success');
  assert.equal(state.body.lastSyncedAt, NOW.toISOString());
  assert.deepEqual(state.body.lastRefreshed, ['league', 'rosters']);
  assert.equal(state.body.resourceFreshness['league:1234'], NOW.toISOString());
  assert.ok(state.body.nextAttemptAt);
});

test('the league being refreshed becomes a persisted connection the scheduler owns', async () => {
  const { app, store, worker, session } = await fixture();
  await refresh(app, session, '/api/sync/1234');
  await worker.drain();
  const connection = (await store.leagueConnection('1234'))!;
  assert.equal(connection.status, 'active');
  assert.equal(connection.linked, true);
  assert.equal(connection.week, 5, 'the week comes from the league, not from the request');
});

test('an unavailable Sleeper never fails the refresh request, and the last snapshot keeps being served', async () => {
  const { app, store, worker, session } = await fixture(() => { throw new SleeperApiError(429, 'Sleeper API returned 429', 'rate_limit', true, 45_000); });
  await store.save({ leagueId: '1234', leagueName: 'League 1234', username: 'sample', season: '2026', week: 5, record: '3-2', rank: 2, pointsFor: 500, lastSyncedAt: NOW.toISOString(), matchup: null, roster: [], recommendations: [] } as never);

  const queued = await refresh(app, session, '/api/sync/1234');
  assert.equal(queued.status, 202);
  await worker.drain();

  const state = await request(app).get('/api/sync/1234').set('Cookie', session.cookie);
  assert.equal(state.body.lastStatus, 'failed');
  assert.equal(state.body.lastCategory, 'rate_limit');
  assert.equal(state.body.consecutiveFailures, 1);
  assert.equal(state.body.nextAttemptAt, new Date(NOW.getTime() + 45_000).toISOString(), 'upstream’s own delay decides the retry');

  const dashboard = await request(app).get('/api/dashboard/1234').set('Cookie', state.headers['set-cookie'] ? state.headers['set-cookie'][0].split(';')[0] : session.cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.lastSyncedAt, NOW.toISOString(), 'the last good snapshot is still what the dashboard serves');
});

test('the sample league is refreshed in place and is never queued upstream', async () => {
  const { app, calls, session } = await fixture();
  const demo = await refresh(app, session, '/api/sync/demo');
  assert.equal(demo.status, 200, 'the sample league answers with its snapshot, not with a queued job');
  assert.equal(demo.body.leagueId, 'demo');
  assert.deepEqual(calls, []);
});

test('a league the session does not link is refused before anything is queued', async () => {
  const { app, calls, store } = await fixture();
  const stranger = await signedInAs(store, { sleeperUserId: 'stranger', leagueIds: ['other'] });
  assert.equal((await refresh(app, stranger, '/api/sync/1234')).status, 403);
  assert.equal((await request(app).get('/api/sync/1234').set('Cookie', stranger.cookie)).status, 403);
  assert.deepEqual(calls, []);
});
