import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { JsonStore } from '../store.js';
import { signedInAs } from '../test-support/auth.js';
import { resetDraining, beginDraining } from '../lifecycle.js';
import { silentLogger } from '../log.js';
import { resetRateLimits } from '../rate-limit.js';
import { Counter, Gauge, Histogram, MAX_SERIES, Registry } from './metrics.js';
import { dependencyStatus, liveness, readiness, DEFAULT_THRESHOLDS, type DependencyStatus } from './health.js';
import { evaluate, DEFAULT_ALERT_THRESHOLDS, DeduplicatingSink, type OperationalAlert } from './alerts.js';
import { measured } from './measured-store.js';
import { storageFailures, storageQueryDuration, registry } from './instruments.js';

const ORIGIN = 'https://huddle.example.com';

async function fixture() {
  resetRateLimits();
  resetDraining();
  process.env.ENABLE_DEMO_AUTH = 'true';
  const dir = await mkdtemp(join(tmpdir(), 'sleeper-obs-'));
  const store = new JsonStore(join(dir, 'data.json'));
  const app = createApp(store, undefined, undefined, undefined, undefined, { webOrigins: [ORIGIN], log: silentLogger });
  return { store, app };
}

// --- The registry ---------------------------------------------------------------------------------

test('the Prometheus text format is what a scraper expects', async () => {
  const local = new Registry();
  const requests = local.counter('test_requests_total', 'Requests.', ['route', 'status']);
  const level = local.gauge('test_level', 'A level.');
  const latency = local.histogram('test_latency_seconds', 'Latency.', ['route'], [0.1, 1]);
  requests.inc({ route: '/a', status: '2xx' });
  requests.inc({ route: '/a', status: '2xx' });
  requests.inc({ route: '/b', status: '5xx' });
  level.set({}, 42);
  latency.observe({ route: '/a' }, 0.05);
  latency.observe({ route: '/a' }, 5);

  const text = await local.render();
  assert.match(text, /# HELP test_requests_total Requests\./);
  assert.match(text, /# TYPE test_requests_total counter/);
  assert.match(text, /test_requests_total\{route="\/a",status="2xx"\} 2/);
  assert.match(text, /test_level 42/);
  // A histogram is cumulative by bucket, and `+Inf` is the total.
  assert.match(text, /test_latency_seconds_bucket\{route="\/a",le="0\.1"\} 1/);
  assert.match(text, /test_latency_seconds_bucket\{route="\/a",le="1"\} 1/);
  assert.match(text, /test_latency_seconds_bucket\{route="\/a",le="\+Inf"\} 2/);
  assert.match(text, /test_latency_seconds_count\{route="\/a"\} 2/);
  assert.match(text, /test_latency_seconds_sum\{route="\/a"\} 5\.05/);
  assert.ok(text.endsWith('\n'));
});

test('a label value cannot break out of the exposition format', async () => {
  const local = new Registry();
  const counter = local.counter('test_escaped_total', 'Escaping.', ['name']);
  counter.inc({ name: 'a"b\\c\nd' });
  const text = await local.render();
  assert.match(text, /test_escaped_total\{name="a\\"b\\\\c\\nd"\} 1/);
});

test('cardinality is bounded, so a mistaken label costs a blurred metric and not the process', () => {
  const local = new Registry();
  const counter = local.counter('test_unbounded_total', 'A label that should not have been a label.', ['id']);
  for (let index = 0; index < MAX_SERIES + 50; index += 1) counter.inc({ id: `id-${index}` });
  assert.ok(counter.saturated, 'the metric reports that it overflowed');
  assert.deepEqual(local.saturated(), ['test_unbounded_total']);
  // The counts are still counted; they just stop being attributable.
  const overflow = counter.snapshot().find(series => series.labels.overflow === 'true');
  assert.equal(overflow?.value, 50);
});

test('two metrics cannot share a name, because a scraper would reject the result', () => {
  const local = new Registry();
  local.counter('test_duplicate_total', 'First.');
  assert.throws(() => local.counter('test_duplicate_total', 'Second.'), /already registered/);
});

test('a collector that throws costs its own metric, not the whole scrape', async () => {
  const local = new Registry();
  const good = local.gauge('test_good', 'Collected.');
  local.onCollect(() => { throw new Error('collector failed'); });
  local.onCollect(() => good.set({}, 7));
  assert.match(await local.render(), /test_good 7/);
});

// --- Liveness, readiness and what they disclose ------------------------------------------------------

test('liveness answers from the process alone, including while draining', async () => {
  const { app } = await fixture();
  assert.deepEqual(liveness(), { status: 'ok' });
  const before = await request(app).get('/health/live');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { status: 'ok' });
  try {
    beginDraining();
    // A liveness probe that fails during a graceful shutdown is an orchestrator killing the
    // shutdown it just asked for.
    const draining = await request(app).get('/health/live');
    assert.equal(draining.status, 200, 'draining is the process doing what it was told');
    // Readiness is the one that has to say "stop sending me traffic".
    const ready = await request(app).get('/health/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'draining');
  } finally { resetDraining(); }
});

test('readiness reports storage, and reports it as not ready when storage throws', async () => {
  const { store } = await fixture();
  const healthy = await readiness(store);
  assert.equal(healthy.status, 'ready');
  assert.deepEqual(healthy.checks.find(check => check.name === 'storage'), { name: 'storage', ok: true });

  const broken = { lease: async () => { throw new Error('ENOENT: /var/lib/huddle/store.json'); } };
  const failed = await readiness(broken as never);
  assert.equal(failed.status, 'not-ready');
  assert.equal(failed.checks.find(check => check.name === 'storage')?.ok, false);
  // The reason never reaches the body: the probe is public and the message is a path.
  assert.ok(!JSON.stringify(failed).includes('/var/lib/huddle'));
});

test('the public probes disclose nothing about the deployment', async () => {
  const { app } = await fixture();
  for (const path of ['/health', '/health/live', '/health/ready']) {
    const response = await request(app).get(path);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = JSON.stringify(response.body).toLowerCase();
    for (const leak of ['postgres', 'sqlite', 'node', 'version', '/var', '/app', 'sleeper', 'sportsdata', 'token', 'huddle-worker']) {
      assert.ok(!body.includes(leak), `${path} must not mention ${leak}`);
    }
    // Readiness names which check failed, and nothing about why.
    for (const key of Object.keys(response.body)) assert.ok(['status', 'checks'].includes(key), `${path} exposed '${key}'`);
  }
});

test('the internal picture is authenticated, not public', async () => {
  const { app, store } = await fixture();
  assert.equal((await request(app).get('/api/ops/status')).status, 401);
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['demo'] });
  const status = await request(app).get('/api/ops/status').set('Cookie', session.cookie);
  assert.equal(status.status, 200);
  for (const key of ['scoring', 'forecast', 'leagueSync', 'worker', 'sleeper', 'state']) {
    assert.ok(key in status.body, `the status report is missing '${key}'`);
  }
  assert.equal(status.headers['cache-control'], 'private, no-store');
});

test('dependency status reads the installation and publishes the same numbers it reports', async () => {
  const { store } = await fixture();
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  await store.connectLeague('1234', { season: '2026', week: 1 });
  // Four hours old, past the three-hour staleness threshold.
  await store.updateLeagueConnection('1234', { lastSyncedAt: '2026-09-11T08:00:00.000Z', lastStatus: 'failed', consecutiveFailures: 4 });

  const status = await dependencyStatus({ store, forecast: null, now: () => now });
  assert.equal(status.leagueSync.activeLeagues, 1);
  assert.equal(status.leagueSync.staleLeagues, 1);
  assert.equal(status.leagueSync.worstFailureStreak, 4);
  assert.equal(status.leagueSync.state, 'unavailable', 'every active league being stale is not a degradation');
  // No worker has ever claimed the schedule in this fixture.
  assert.equal(status.worker.state, 'unavailable');
  assert.equal(status.worker.held, false);
  // No feed configured at all is a supported installation, not a fault to be alerted on.
  assert.equal(status.forecast.state, 'unavailable');
  assert.equal(status.forecast.reason, 'no_feed');
  assert.equal(status.state, 'unavailable', 'the worst of the parts is the whole');
});

// --- Alert rules ------------------------------------------------------------------------------------

const healthy: DependencyStatus = {
  scoring: { state: 'ready', leagues: 3, unavailable: 0, stale: 0, oldestObservedAt: '2026-09-11T11:00:00.000Z' },
  forecast: { state: 'ready', ingestedAt: '2026-09-11T11:00:00.000Z', ageSeconds: 3_600, sourceUpdatedAt: '2026-09-11T10:00:00.000Z', players: 900, identityMatchRate: 0.99, coverageComplete: true, reason: null },
  leagueSync: { state: 'ready', activeLeagues: 3, lastSuccessAt: '2026-09-11T11:55:00.000Z', oldestSuccessAt: '2026-09-11T11:50:00.000Z', staleLeagues: 0, failingLeagues: 0, worstFailureStreak: 0 },
  worker: { state: 'ready', heartbeatAt: '2026-09-11T11:58:00.000Z', ageSeconds: 120, held: true },
  sleeper: { state: 'ready', calls: 400, failures: 2, errorRate: 0.005 },
  state: 'ready',
};
const quiet = { requests: 0, serverErrors: 0, storageFailures: 0 };
const ids = (alerts: OperationalAlert[]) => alerts.map(alert => alert.id).sort();

test('a healthy installation raises nothing at all', () => {
  assert.deepEqual(evaluate(healthy, { requests: 5_000, serverErrors: 3, storageFailures: 0 }), []);
});

test('each of the six conditions raises its own alert, and each names its runbook step', () => {
  const cases: Array<[string, DependencyStatus, typeof quiet]> = [
    ['stale-scoring', { ...healthy, scoring: { ...healthy.scoring, state: 'degraded', unavailable: 1 } }, quiet],
    ['stale-projections', { ...healthy, forecast: { ...healthy.forecast, state: 'stale', ageSeconds: 50_000 } }, quiet],
    ['repeated-sync-failures', { ...healthy, leagueSync: { ...healthy.leagueSync, state: 'stale', staleLeagues: 2 } }, quiet],
    ['worker-inactive', { ...healthy, worker: { state: 'unavailable', heartbeatAt: null, ageSeconds: null, held: false } }, quiet],
    ['elevated-5xx', healthy, { requests: 1_000, serverErrors: 200, storageFailures: 0 }],
    ['storage-failures', healthy, { requests: 100, serverErrors: 0, storageFailures: 40 }],
  ];
  for (const [expected, status, traffic] of cases) {
    const alerts = evaluate(status, traffic);
    assert.deepEqual(ids(alerts), [expected], `expected exactly ${expected}`);
    assert.equal(alerts[0]!.runbook, `docs/runbook.md#${expected}`);
    // A summary is read first and is often forwarded; it carries numbers, never identifiers.
    assert.ok(alerts[0]!.summary.length > 0);
    assert.ok(!/\//.test(alerts[0]!.summary.replace(/docs\/runbook[^\s]*/, '')), 'no paths in a summary');
  }
});

test('a rate needs a denominator worth dividing by', () => {
  // One 500 out of three requests at four in the morning is not a 33% error rate.
  assert.deepEqual(evaluate(healthy, { requests: 3, serverErrors: 1, storageFailures: 0 }), []);
  assert.deepEqual(ids(evaluate(healthy, { requests: 1_000, serverErrors: 100, storageFailures: 0 })), ['elevated-5xx']);
});

test('severity escalates with the blast radius rather than being fixed per rule', () => {
  const partial = evaluate({ ...healthy, scoring: { ...healthy.scoring, state: 'degraded', unavailable: 1 } }, quiet);
  assert.equal(partial[0]!.severity, 'warning');
  const total = evaluate({ ...healthy, scoring: { ...healthy.scoring, state: 'unavailable', unavailable: 3 } }, quiet);
  assert.equal(total[0]!.severity, 'critical', 'every league is a different problem from one league');
});

test('a forecast that was never configured is a supported installation, not an alert', () => {
  const absent: DependencyStatus = { ...healthy, forecast: { state: 'unavailable', ingestedAt: null, ageSeconds: null, sourceUpdatedAt: null, players: null, identityMatchRate: null, coverageComplete: null, reason: 'no_feed' } };
  assert.deepEqual(evaluate(absent, quiet), []);
});

test('a single failed synchronization does not need a person', () => {
  const blip: DependencyStatus = { ...healthy, leagueSync: { ...healthy.leagueSync, failingLeagues: 1, worstFailureStreak: 1 } };
  assert.deepEqual(evaluate(blip, quiet), [], 'the backoff exists so that one failure is not an incident');
  const streak: DependencyStatus = { ...healthy, leagueSync: { ...healthy.leagueSync, failingLeagues: 1, worstFailureStreak: DEFAULT_ALERT_THRESHOLDS.failureStreak } };
  assert.deepEqual(ids(evaluate(streak, quiet)), ['repeated-sync-failures']);
});

test('a condition that lasts an hour is one alert, and an escalation is never suppressed', async () => {
  const delivered: OperationalAlert[] = [];
  let clock = 0;
  const sink = new DeduplicatingSink({ deliver: alert => { delivered.push(alert); } }, 60 * 60_000, () => clock);
  const warning = evaluate({ ...healthy, scoring: { ...healthy.scoring, state: 'degraded', unavailable: 1 } }, quiet)[0]!;
  await sink.deliver(warning);
  clock += 5 * 60_000;
  await sink.deliver(warning);
  assert.equal(delivered.length, 1, 'the same condition is not re-delivered inside the window');
  // An escalation is a different message about a worse situation, and must not wait out the window.
  await sink.deliver({ ...warning, severity: 'critical' });
  assert.equal(delivered.length, 2);
  clock += 61 * 60_000;
  await sink.deliver(warning);
  assert.equal(delivered.length, 3, 'a condition that is still true after the window is reported again');
});

// --- Storage timing ---------------------------------------------------------------------------------

test('every repository call is timed, and a failure is counted as well as thrown', async () => {
  registry.reset();
  const store = measured({
    async league(id: string) { return { id }; },
    async applySync() { throw new Error("ENOENT: open '/var/lib/huddle/store.json'"); },
  });
  assert.deepEqual(await store.league('1234'), { id: '1234' });
  assert.equal(storageQueryDuration.count({ operation: 'league' }), 1);
  assert.equal(storageFailures.value({ operation: 'league' }), 0);

  await assert.rejects(() => store.applySync(), /ENOENT/, 'the failure still reaches the caller');
  assert.equal(storageQueryDuration.count({ operation: 'applySync' }), 1, 'a failed call is still timed');
  assert.equal(storageFailures.value({ operation: 'applySync' }), 1);
  registry.reset();
});

// --- HTTP instrumentation -----------------------------------------------------------------------------

test('requests are counted by route pattern and status class, never by path', async () => {
  registry.reset();
  const { app, store } = await fixture();
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['1234', '5678'] });
  await request(app).get('/api/dashboard/1234').set('Cookie', session.cookie);
  await request(app).get('/api/dashboard/5678').set('Cookie', session.cookie);
  const text = await registry.render();
  // Two different leagues are one series: the label is the route pattern, so cardinality is fixed by
  // the route table rather than by how many leagues exist.
  assert.match(text, /huddle_http_requests_total\{route="\/api\/dashboard\/:leagueId",method="GET",status="4xx"\} 2/);
  assert.ok(!text.includes('1234'), 'an identifier from a path must never become a label');
  assert.match(text, /huddle_http_request_duration_seconds_count\{route="\/api\/dashboard\/:leagueId",method="GET"\} 2/);
  registry.reset();
});

test('a refused request records which budget dimension ran out', async () => {
  registry.reset();
  const { app } = await fixture();
  // The sign-in address budget is ten in fifteen minutes.
  for (let attempt = 0; attempt < 12; attempt += 1) await request(app).post('/auth/login').send({ login: 'admin', password: 'wrong' });
  const text = await registry.render();
  assert.match(text, /huddle_rate_limit_events_total\{bucket="login",scope="address"\}/);
  // And the reason authentication failed, which is a different question from how often it did.
  assert.match(text, /huddle_auth_failures_total/);
  registry.reset();
});

// --- The thresholds themselves -------------------------------------------------------------------

test('the default thresholds are coherent with the schedule they watch', () => {
  // Two sweeps at the default interval. One missed sweep is a restart; two is a worker that is gone.
  assert.ok(DEFAULT_THRESHOLDS.workerHeartbeatMs > 2 * 30 * 60_000);
  // A league is stale well before the forecast is: it is refreshed far more often.
  assert.ok(DEFAULT_THRESHOLDS.leagueStaleMs < DEFAULT_THRESHOLDS.forecastStaleMs);
  // A rate needs a denominator before it means anything.
  assert.ok(DEFAULT_ALERT_THRESHOLDS.minRequestsForRate >= 20);
});

test('a gauge with nothing behind it is absent rather than zero', async () => {
  const local = new Registry();
  const pool = local.gauge('test_pool', 'Connections.', ['state']);
  assert.ok(!(await local.render()).includes('test_pool{'));
  pool.set({ state: 'idle' }, 3);
  assert.match(await local.render(), /test_pool\{state="idle"\} 3/);
  // A dashboard renders a permanent zero as a healthy number and nobody asks why it never moves.
  pool.clear();
  assert.ok(!(await local.render()).includes('test_pool{'));
});

test('counters, gauges and histograms are the three shapes and behave like them', () => {
  const counter = new Counter('c', 'c');
  counter.inc(); counter.inc({}, 4);
  assert.equal(counter.value(), 5);
  const gauge = new Gauge('g', 'g');
  gauge.set({}, 10); gauge.dec({}, 3);
  assert.equal(gauge.value(), 7);
  const histogram = new Histogram('h', 'h', [], [1]);
  histogram.observe({}, 0.5);
  assert.equal(histogram.count(), 1);
});
