import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { League } from '@sleeper/domain';
import { SleeperApiError } from '@sleeper/sleeper-client';
import { JsonStore } from '../store.js';
import type { SyncResult } from '../sync.js';
import { StoreSyncLock } from './lock.js';
import { leagueLeaseKey, LeagueSyncWorker, SWEEP_LEASE_KEY, type LeagueSyncWorkerOptions } from './worker.js';

const ENV = { NFL_SEASON: '2026', NFL_WEEK_ONE_TUESDAY: '2026-09-08T00:00:00Z' } as NodeJS.ProcessEnv;
const START = new Date('2026-10-06T12:00:00Z'); // Week 5 of the 2026 season.
const silent = { info: () => {}, error: () => {} };

const league = (id: string, overrides: Partial<League> = {}): League => ({
  id, name: `League ${id}`, season: '2026', status: 'in_season', previousLeagueId: null, totalRosters: 12,
  rosterPositions: [], scoringSettings: [], settings: { leg: 5 }, sourceUpdatedAt: null, synchronizedAt: START.toISOString(), ...overrides,
});

async function fixture(leagueIds: string[], leagues: League[] = leagueIds.filter(id => id !== 'demo').map(id => league(id))) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'league-sync-')), 'store.json'));
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: leagueIds, createdAt: START.toISOString() });
  for (const value of leagues) await store.applySync({ league: value, freshness: { [`league:${value.id}`]: START.toISOString(), 'players:nfl': START.toISOString() } });
  return store;
}

/** A stand-in for `LeagueSyncService`, recording every call and reporting peak overlap. */
function synchronizer(behavior: (leagueId: string, week: number) => Promise<void> | void = () => {}) {
  const calls: Array<{ leagueId: string; week: number; force: boolean }> = [];
  let active = 0, peak = 0;
  return {
    calls, get peak() { return peak; },
    async syncLeague(leagueId: string, week: number, force = false): Promise<SyncResult> {
      calls.push({ leagueId, week, force });
      peak = Math.max(peak, ++active);
      try { await behavior(leagueId, week); return { leagueId, synchronizedAt: new Date().toISOString(), refreshed: ['league', 'rosters'], scoring: { kind: 'complete-live' } as never }; }
      finally { active -= 1; }
    },
  };
}

function build(store: JsonStore, sync: { syncLeague: (id: string, week: number, force?: boolean) => Promise<SyncResult> }, options: LeagueSyncWorkerOptions = {}) {
  let clock = START;
  const slept: number[] = [];
  const worker = new LeagueSyncWorker(store, sync, {
    logger: silent, env: ENV, now: () => clock, random: () => 0, sleep: async ms => { slept.push(ms); },
    concurrency: 2, sweepIntervalMs: 30 * 60_000, jitterMs: 0, runOnStart: false, ...options,
  });
  return { worker, slept, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, at: () => clock };
}

/** Waits for a condition, then lets the loop settle, so "nothing else started" is a real assertion. */
async function settled(until: () => boolean, attempts = 400) {
  for (let attempt = 0; attempt < attempts && !until(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setImmediate(resolve));
}

test('a sweep synchronizes every active connected league, records the outcome, and waits out its own interval', async () => {
  const store = await fixture(['l1', 'l2']);
  const sync = synchronizer();
  const { worker, advance } = build(store, sync);

  const first = await worker.sweep('test');
  assert.equal(first.ranSweep, true);
  assert.deepEqual(first.queued.sort(), ['l1', 'l2']);
  assert.deepEqual(sync.calls.map(call => `${call.leagueId}:${call.week}`).sort(), ['l1:5', 'l2:5'], 'the league’s own week is synchronized');
  assert.ok(first.results.every(result => result.status === 'success'));

  const connection = (await store.leagueConnection('l1'))!;
  assert.equal(connection.status, 'active');
  assert.equal(connection.linked, true);
  assert.equal(connection.season, '2026');
  assert.equal(connection.week, 5);
  assert.equal(connection.lastStatus, 'success');
  assert.equal(connection.lastSyncedAt, START.toISOString());
  assert.equal(connection.lastCategory, undefined);
  assert.equal(typeof connection.lastDurationMs, 'number');
  assert.deepEqual(connection.lastRefreshed, ['league', 'rosters']);
  assert.equal(connection.resourceFreshness!['league:l1'], START.toISOString(), 'per-resource freshness is recorded, not only a single timestamp');
  assert.equal(connection.resourceFreshness!['players:nfl'], START.toISOString());
  assert.equal(connection.nextAttemptAt, new Date(START.getTime() + 30 * 60_000).toISOString());
  assert.equal(connection.consecutiveFailures, 0);

  // A second sweep inside the interval must not spend another fan-out on the same league.
  const immediate = await worker.sweep('test');
  assert.deepEqual(immediate.queued, []);
  assert.deepEqual(immediate.skipped.map(entry => entry.reason).sort(), ['awaiting-retry', 'awaiting-retry']);
  assert.equal(sync.calls.length, 2);

  // Past it, every league is synchronized again — which is how commissioner scoring changes are picked
  // up: each pass re-reads the league's metadata and its full scoring settings.
  advance(31 * 60_000);
  await worker.sweep('test');
  assert.equal(sync.calls.length, 4);
});

test('the sample league is never scheduled unless the demo opt-in is on', async () => {
  const store = await fixture(['l1', 'demo']);
  const production = synchronizer();
  const { worker } = build(store, production, { demo: () => false });
  const report = await worker.sweep('test');
  assert.deepEqual(report.queued, ['l1']);
  assert.deepEqual(report.skipped, [{ leagueId: 'demo', reason: 'demo-disabled' }]);
  assert.ok(production.calls.every(call => call.leagueId !== 'demo'));
  assert.equal((await store.leagueConnection('demo'))!.demo, true, 'the connection is still persisted, it is simply not scheduled');

  const development = synchronizer();
  const enabled = build(store, development, { demo: () => true });
  const allowed = await enabled.worker.sweep('test');
  assert.deepEqual(allowed.queued, ['demo'], 'l1 is still inside its interval; the sample league is now eligible');
  assert.deepEqual(development.calls.map(call => call.leagueId), ['demo']);
});

test('concurrency is bounded no matter how many leagues are connected', async () => {
  const ids = ['l1', 'l2', 'l3', 'l4', 'l5'];
  const store = await fixture(ids);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = synchronizer(async () => { await gate; });
  const { worker } = build(store, sync, { concurrency: 2 });
  const sweep = worker.sweep('test');
  // Let the sweep get as far as it can while every league it started is blocked upstream.
  await settled(() => sync.calls.length >= 2);
  assert.equal(sync.calls.length, 2, 'never more than the configured number of leagues in flight');
  assert.equal(sync.peak, 2);
  release();
  const report = await sweep;
  assert.equal(report.results.length, 5);
  assert.equal(sync.peak, 2);
  assert.deepEqual(sync.calls.map(call => call.leagueId).sort(), ids);
});

test('a league already held by another worker is left to it, and the sweep lease keeps one instance in charge', async () => {
  const store = await fixture(['l1', 'l2']);
  const sync = synchronizer();
  const { worker } = build(store, sync);

  // Another instance is synchronizing l1 right now.
  await store.acquireLease(leagueLeaseKey('l1'), 'another-worker', 60_000, START);
  worker.enqueue('l1', { reason: 'manual' });
  const [result] = await worker.drain();
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'lease-held');
  assert.deepEqual(sync.calls, []);

  // And another instance owns the schedule itself.
  await store.acquireLease(SWEEP_LEASE_KEY, 'another-worker', 60_000, START);
  const report = await worker.sweep('test');
  assert.equal(report.ranSweep, false);
  assert.deepEqual(report.queued, []);
  assert.deepEqual(sync.calls, []);

  // Two workers over one store sweep exactly once between them.
  await store.releaseLease(SWEEP_LEASE_KEY, 'another-worker');
  await store.releaseLease(leagueLeaseKey('l1'), 'another-worker');
  const shared = synchronizer();
  const a = build(store, shared, { lock: new StoreSyncLock(store, 'worker-a', () => START) });
  const b = build(store, shared, { lock: new StoreSyncLock(store, 'worker-b', () => START) });
  const [reportA, reportB] = await Promise.all([a.worker.sweep('test'), b.worker.sweep('test')]);
  assert.equal([reportA, reportB].filter(value => value.ranSweep).length, 1, 'exactly one instance sweeps');
  assert.deepEqual(shared.calls.map(call => call.leagueId).sort(), ['l1', 'l2']);
});

test('a failure keeps the last good snapshot, records the category, and retries when upstream says to', async () => {
  const store = await fixture(['l1']);
  let failure: Error | null = null;
  const sync = synchronizer(() => { if (failure) throw failure; });
  const { worker, advance } = build(store, sync, { baseRetryMs: 60_000, maxRetryMs: 3_600_000 });
  await worker.sweep('test');
  const good = (await store.leagueConnection('l1'))!.lastSyncedAt;
  assert.ok(good);

  // Sleeper asks for ninety seconds; the worker takes it rather than its own curve.
  advance(31 * 60_000);
  failure = new SleeperApiError(429, 'Sleeper API returned 429', 'rate_limit', true, 90_000);
  await worker.sweep('test');
  let connection = (await store.leagueConnection('l1'))!;
  assert.equal(connection.lastStatus, 'failed');
  assert.equal(connection.lastCategory, 'rate_limit');
  assert.equal(connection.consecutiveFailures, 1);
  assert.equal(connection.lastSyncedAt, good, 'the last good synchronization is retained through the failure');
  assert.ok(await store.league('l1'), 'nothing stored is removed by a failure');
  assert.equal(connection.nextAttemptAt, new Date(START.getTime() + 31 * 60_000 + 90_000).toISOString());

  // Inside that window the league is not touched again.
  advance(30_000);
  assert.deepEqual((await worker.sweep('test')).skipped, [{ leagueId: 'l1', reason: 'awaiting-retry' }]);

  // Without guidance the backoff doubles from the base delay.
  advance(90_000);
  failure = new SleeperApiError(503, 'Sleeper API is unavailable', 'server', true);
  await worker.sweep('test');
  connection = (await store.leagueConnection('l1'))!;
  assert.equal(connection.consecutiveFailures, 2);
  assert.equal(connection.lastCategory, 'server');
  assert.equal(Date.parse(connection.nextAttemptAt!) - Date.parse(connection.lastAttemptedAt!), 120_000);

  // And a recovery clears the failure state rather than leaving a stale category behind.
  advance(200_000);
  failure = null;
  await worker.sweep('test');
  connection = (await store.leagueConnection('l1'))!;
  assert.equal(connection.lastStatus, 'success');
  assert.equal(connection.consecutiveFailures, 0);
  assert.equal(connection.lastCategory, undefined);
});

test('attempts are spread by randomized jitter rather than firing on the same instant', async () => {
  const store = await fixture(['l1', 'l2']);
  const sync = synchronizer();
  const { worker, slept } = build(store, sync, { jitterMs: 10_000, random: () => 0.5 });
  const report = await worker.sweep('test');
  assert.deepEqual(slept, [5_000, 5_000], 'every attempt waits a random offset before reaching Sleeper');
  assert.equal((await store.leagueConnection('l1'))!.nextAttemptAt, new Date(START.getTime() + 30 * 60_000 + 5_000).toISOString());
  assert.ok(report.results.every(result => result.status === 'success'));
});

test('the connection set follows the linked accounts', async () => {
  const store = await fixture(['l1', 'l2']);
  const { worker } = build(store, synchronizer());
  await worker.sweep('test');
  assert.deepEqual((await store.activeLeagueConnections()).map(value => value.leagueId).sort(), ['l1', 'l2']);

  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: ['l1'], createdAt: START.toISOString() });
  await worker.sweep('test');
  const dropped = (await store.leagueConnection('l2'))!;
  assert.equal(dropped.status, 'archived');
  assert.equal(dropped.archivedReason, 'unlinked');
  assert.equal(dropped.linked, false);
  assert.ok(await store.league('l2'), 'unlinking stops synchronization; it does not delete anything');

  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: ['l1', 'l2'], createdAt: START.toISOString() });
  await worker.sweep('test');
  assert.equal((await store.leagueConnection('l2'))!.status, 'active', 're-linking revives the connection it archived');
});

test('retention archives a finished season and prunes only archived leagues nobody links', async () => {
  const store = await fixture(['current', 'finished'], [league('current'), league('finished', { season: '2025', status: 'complete', settings: { leg: 14 } })]);
  const sync = synchronizer();
  const { worker, advance } = build(store, sync, { retention: { archiveAfterMs: 30 * 24 * 3_600_000, pruneAfterMs: 180 * 24 * 3_600_000 } });

  const first = await worker.sweep('test');
  assert.deepEqual(first.queued, ['current']);
  assert.deepEqual(first.skipped, [{ leagueId: 'finished', reason: 'historical' }], 'a finished season is not synchronized while it is still inside the retention window');
  assert.deepEqual(first.archived, []);

  advance(31 * 24 * 3_600_000);
  const archived = await worker.sweep('test');
  assert.deepEqual(archived.archived, ['finished']);
  const connection = (await store.leagueConnection('finished'))!;
  assert.equal(connection.status, 'archived');
  assert.equal(connection.archivedReason, 'inactive-season');
  assert.ok(await store.league('finished'), 'archiving retains every byte of last season');

  // Still linked, so it is never deleted however long it has been archived.
  advance(200 * 24 * 3_600_000);
  assert.deepEqual((await worker.sweep('test')).pruned, []);
  assert.ok(await store.league('finished'));

  // Unlinked and long archived, it is finally pruned along with its observations.
  await store.applySync({ weeklySnapshot: { id: 'finished:2025:14:x', leagueId: 'finished', season: '2025', week: 14, rosterIds: [], matchupIds: [], rosters: [{ id: 'finished:1', leagueId: 'finished', rosterId: 1, ownerId: 'u', coOwnerIds: [], playerIds: [], starterIds: [], reserveIds: [], taxiIds: [], settings: {}, sourceUpdatedAt: null, synchronizedAt: START.toISOString() }], matchups: [], scoring: { kind: 'unavailable' } as never, sourceUpdatedAt: null, synchronizedAt: START.toISOString() } });
  await store.applySync({ rosters: [{ id: 'finished:1', leagueId: 'finished', rosterId: 1, ownerId: 'u', coOwnerIds: [], playerIds: [], starterIds: [], reserveIds: [], taxiIds: [], settings: {}, sourceUpdatedAt: null, synchronizedAt: START.toISOString() }] });
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: ['current'], createdAt: START.toISOString() });
  const pruned = await worker.sweep('test');
  assert.deepEqual(pruned.pruned, ['finished']);
  assert.equal(await store.league('finished'), undefined);
  assert.equal(await store.leagueConnection('finished'), undefined);
  assert.equal((await store.lineupContext('finished', '2025', 14)).rosters.length, 0);
  assert.ok(await store.league('current'), 'the leagues someone still plays are untouched');
});

test('a manual refresh queues one job, coalesces repeats, and reports its own state', async () => {
  const store = await fixture(['l1']);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = synchronizer(async () => { await gate; });
  const { worker } = build(store, sync);

  const first = worker.enqueue('l1', { reason: 'manual', force: true });
  const second = worker.enqueue('l1', { reason: 'manual' });
  assert.equal(first, second, 'a second press joins the job already in progress rather than duplicating it');
  assert.equal(worker.state('l1').running, true);
  release();
  const results = await worker.drain();
  assert.equal(results.length, 1);
  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].force, true, 'the force flag survives coalescing');
  assert.equal(worker.state('l1').queued, false);
  assert.equal(worker.state('l1').running, false);
  assert.equal((await store.leagueConnection('l1'))!.lastStatus, 'success');
});

test('an unexpected error inside one job never stops the queue', async () => {
  const store = await fixture(['l1', 'l2']);
  const sync = synchronizer(leagueId => { if (leagueId === 'l1') throw new Error('boom'); });
  const { worker } = build(store, sync, { concurrency: 1 });
  const report = await worker.sweep('test');
  assert.deepEqual(report.results.map(result => `${result.leagueId}:${result.status}`).sort(), ['l1:failed', 'l2:success']);
  assert.equal((await store.leagueConnection('l1'))!.lastCategory, 'internal');
  assert.equal((await store.leagueConnection('l2'))!.lastStatus, 'success');
});
