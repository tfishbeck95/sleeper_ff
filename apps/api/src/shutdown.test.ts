import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { League } from '@sleeper/domain';
import { isDraining, resetDraining } from './lifecycle.js';
import { closeHttpServer, GracefulShutdown } from './shutdown.js';
import { LeagueSyncWorker, SWEEP_LEASE_KEY, leagueLeaseKey } from './scheduler/index.js';
import { JsonStore } from './store.js';
import type { SyncResult } from './sync.js';

const silent = { info: () => {}, error: () => {} };
const deferred = () => { let release!: () => void; const waited = new Promise<void>(resolve => { release = resolve; }); return { waited, release }; };

afterEach(() => resetDraining());

test('steps run in the order they were added, each awaited before the next', async () => {
  const order: string[] = [];
  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent });
  shutdown.add('first', async () => { await new Promise(resolve => setTimeout(resolve, 10)); order.push('first'); });
  shutdown.add('second', () => { order.push('second'); });
  shutdown.add('third', async () => { await Promise.resolve(); order.push('third'); });

  assert.equal(await shutdown.shutdown('SIGTERM'), 0);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('draining starts before the first step, so /health reports it while requests are still finishing', async () => {
  let drainingDuringFirstStep = false;
  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent });
  shutdown.add('observe', () => { drainingDuringFirstStep = isDraining(); });

  assert.equal(isDraining(), false);
  await shutdown.shutdown('SIGTERM');
  assert.equal(drainingDuringFirstStep, true);
  assert.equal(isDraining(), true);
});

test('a step that fails does not stop the ones after it, and the exit code records it', async () => {
  const order: string[] = [];
  const errors: string[] = [];
  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: { info: () => {}, error: message => errors.push(message) } });
  shutdown.add('stop accepting work', () => { order.push('stop'); });
  shutdown.add('drain', () => { throw new Error('upstream went away'); });
  // Releasing the lease and closing the store matter more when draining has just failed, not less.
  shutdown.add('close the storage handle', () => { order.push('close'); });

  assert.equal(await shutdown.shutdown('SIGTERM'), 1);
  assert.deepEqual(order, ['stop', 'close']);
  assert.ok(errors.some(message => /drain failed/.test(message)));
});

test('the grace period is bounded, and the message names the step that was still outstanding', async () => {
  const errors: string[] = [];
  const held = deferred();
  const shutdown = new GracefulShutdown({ graceMs: 30, logger: { info: () => {}, error: message => errors.push(message) } });
  shutdown.add('drain in-flight synchronizations', () => held.waited);
  shutdown.add('close the storage handle', () => {});

  assert.equal(await shutdown.shutdown('SIGTERM'), 1);
  assert.ok(errors.some(message => /grace period expired while waiting on drain in-flight synchronizations/.test(message)), errors.join('\n'));
  held.release();
});

test('shutting down twice runs the steps once', async () => {
  let runs = 0;
  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent });
  shutdown.add('count', () => { runs += 1; });

  const [first, second] = await Promise.all([shutdown.shutdown('SIGTERM'), shutdown.shutdown('SIGINT')]);
  assert.equal(runs, 1);
  assert.equal(first, 0);
  assert.equal(second, 0);
});

test('a signal drains and exits with the sequence code; a second one exits immediately', async () => {
  const codes: number[] = [];
  const held = deferred();
  const signals = new EventEmitter();
  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent, exit: code => codes.push(code), signals: ['SIGTERM'] });
  shutdown.add('drain', () => held.waited);

  const uninstall = shutdown.listen(signals);
  signals.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(codes, [], 'the first signal waits for the drain');

  // An operator who signals, waits, and signals again has decided the drain is not going to finish.
  signals.emit('SIGTERM');
  assert.deepEqual(codes, [1]);

  held.release();
  await shutdown.shutdown('SIGTERM');
  assert.deepEqual(codes, [1, 0]);
  uninstall();
  signals.emit('SIGTERM');
  assert.deepEqual(codes, [1, 0], 'removing the handlers stops it listening');
});

test('closing the HTTP server finishes the request in flight and stops waiting on idle keep-alive sockets', async () => {
  const held = deferred();
  const server = createServer((_request, response) => { void held.waited.then(() => response.end('done')); });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  // A keep-alive agent leaves a socket open after the response, which is what `server.close()` alone
  // would wait on forever.
  const inFlight = fetch(`http://127.0.0.1:${port}/`).then(response => response.text());
  await new Promise(resolve => setTimeout(resolve, 20));

  const closing = closeHttpServer(server, 1_000);
  let closed = false;
  void closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false, 'the request already being served is not cut off');

  held.release();
  assert.equal(await inFlight, 'done');
  await closing;
  assert.equal(closed, true);
  // Closing an already-closed server is the state the caller wanted, not an error.
  await closeHttpServer(server, 1_000);
});

test('draining waits for a synchronization already in flight, and leaves no lease behind', async () => {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'shutdown-')), 'store.json'));
  const now = new Date('2026-10-06T12:00:00Z');
  const league: League = {
    id: 'L1', name: 'League L1', season: '2026', status: 'in_season', previousLeagueId: null, totalRosters: 12,
    rosterPositions: [], scoringSettings: [], settings: { leg: 5 }, sourceUpdatedAt: null, synchronizedAt: now.toISOString(),
  };
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: ['L1'], createdAt: now.toISOString() });
  await store.applySync({ league, freshness: { 'league:L1': now.toISOString() } });

  const held = deferred();
  let finished = false;
  const sync = {
    async syncLeague(leagueId: string): Promise<SyncResult> {
      await held.waited;
      finished = true;
      return { leagueId, synchronizedAt: new Date().toISOString(), refreshed: ['league'], scoring: { kind: 'complete-live' } as never };
    },
  };
  const worker = new LeagueSyncWorker(store, sync, {
    logger: silent, env: { NFL_SEASON: '2026', NFL_WEEK_ONE_TUESDAY: '2026-09-08T00:00:00Z' } as NodeJS.ProcessEnv,
    now: () => now, random: () => 0, jitterMs: 0, runOnStart: false, concurrency: 1,
  });

  const sweeping = worker.sweep('test');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(worker.state('L1').running, true, 'the job is in flight before shutdown begins');

  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent });
  shutdown.add('stop accepting new work', () => worker.stop());
  shutdown.add('finish the work already in flight', () => worker.settled());
  shutdown.add('close the storage handle', () => store.close?.());

  const draining = shutdown.shutdown('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, false, 'shutdown does not abandon a synchronization part-way through');

  held.release();
  assert.equal(await draining, 0);
  assert.equal(finished, true);
  await sweeping;

  // Leases released rather than left to expire: a replacement instance picks the schedule straight up.
  assert.equal(await store.acquireLease(SWEEP_LEASE_KEY, 'replacement', 60_000, now) !== null, true);
  assert.equal(await store.acquireLease(leagueLeaseKey('L1'), 'replacement', 60_000, now) !== null, true);
});

test('closing the storage handle waits for queued writes to reach the file', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'shutdown-store-')), 'store.json');
  const store = new JsonStore(path);
  const created = new Date().toISOString();
  // Not awaited: this is the write that a process killed on SIGTERM would lose.
  void store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: [], createdAt: created });

  const shutdown = new GracefulShutdown({ graceMs: 5_000, logger: silent });
  shutdown.add('close the storage handle', () => store.close?.());
  assert.equal(await shutdown.shutdown('SIGTERM'), 0);

  assert.equal((await new JsonStore(path).applicationUserByLogin('admin'))?.id, 'u1');
});
