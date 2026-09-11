import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleeperApiError } from '@sleeper/sleeper-client';
import { createApp } from '../app.js';
import { JsonStore } from '../store.js';
import { passwordHash } from '../auth.js';
import { rateLimit, resetRateLimits, clientAddress } from '../rate-limit.js';
import { signedInAs } from '../test-support/auth.js';
import { CorsConfigurationError } from './cors.js';
import { classify, errorHandler, HttpError } from './errors.js';
import { ProviderFetchError } from '../providers/http.js';
import { silentLogger } from '../log.js';

/**
 * The properties that have to hold for every response, not only for the ones a route produced.
 *
 * Most of what this file asserts is about the responses nobody writes on purpose: the 404 from the
 * router, the 415 from the body guard, the 429 from a limiter, the 500 from a defect. Those are the
 * responses a header or a cache directive goes missing from, because they are the ones no route
 * handler ever touches.
 */

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://huddle.example.com';

async function fixture(options: Parameters<typeof createApp>[5] = {}) {
  resetRateLimits();
  process.env.ENABLE_DEMO_AUTH = 'true';
  const dir = await mkdtemp(join(tmpdir(), 'sleeper-hardening-'));
  const store = new JsonStore(join(dir, 'data.json'));
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: await passwordHash(PASSWORD), sleeperUserId: 'sample', sleeperLeagueIds: ['demo'], createdAt: new Date().toISOString() });
  const app = createApp(store, undefined, undefined, undefined, undefined, { webOrigins: [ORIGIN], log: silentLogger, ...options });
  return { store, app };
}

// --- Security headers ---------------------------------------------------------------------------

test('every response carries the security headers, including the ones no route produced', async () => {
  const { app } = await fixture();
  const responses = [
    await request(app).get('/health'),
    await request(app).get('/nothing-is-here'),
    await request(app).get('/api/dashboard/demo'),
  ];
  for (const response of responses) {
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(response.headers['content-security-policy'], /sandbox/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-site');
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['origin-agent-cluster'], '?1');
    assert.match(response.headers['permissions-policy'], /camera=\(\)/);
    assert.equal(response.headers['x-powered-by'], undefined, 'the framework does not announce itself');
  }
  assert.equal(responses[2]!.status, 401, 'and the unauthenticated case is still refused');
});

test('HSTS is asserted only where TLS actually terminates', async () => {
  const plain = await fixture({ https: false });
  assert.equal((await request(plain.app).get('/health')).headers['strict-transport-security'], undefined);
  const secured = await fixture({ https: true });
  assert.match((await request(secured.app).get('/health')).headers['strict-transport-security'], /max-age=\d+; includeSubDomains/);
});

// --- The public health endpoint -----------------------------------------------------------------

test('health is public and discloses nothing about the deployment', async () => {
  const { app } = await fixture();
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  // Exactly one field. Not the version, the environment, the storage adapter, the worker's identity,
  // whether an upstream is reachable, or any path.
  assert.deepEqual(response.body, { status: 'ok' });
  assert.deepEqual(Object.keys(response.body), ['status']);
  // A cached liveness answer is a load balancer being told an instance is up because it was.
  assert.equal(response.headers['cache-control'], 'no-store');
  const serialized = JSON.stringify(response.body);
  for (const leak of ['/', 'postgres', 'sleeper', 'node', 'version', 'env']) {
    assert.ok(!serialized.toLowerCase().includes(leak), `health must not mention ${leak}`);
  }
});

// --- Cache-control ------------------------------------------------------------------------------

test('user-specific responses are private and never stored; the sample league is the one exception', async () => {
  const { app, store } = await fixture();
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['demo', '1234'] });
  const refused = await request(app).get('/api/dashboard/1234').set('Cookie', session.cookie);
  assert.equal(refused.headers['cache-control'], 'private, no-store');
  assert.match(refused.headers.vary, /Cookie/);
  assert.match(refused.headers.vary, /Origin/);
  // The sample league is generated fiction with no account in it, and is refused in production.
  const demo = await request(app).get('/api/waivers/demo').set('Cookie', session.cookie);
  assert.equal(demo.status, 200);
  assert.match(demo.headers['cache-control'], /^public, max-age=\d+, must-revalidate$/);
});

// --- Request bodies -----------------------------------------------------------------------------

test('a body is refused by type and by size before any route reads it', async () => {
  const { app } = await fixture();
  const form = await request(app).post('/auth/login').set('Content-Type', 'application/x-www-form-urlencoded').send('login=admin&password=x');
  assert.equal(form.status, 415);
  assert.equal(form.body.code, 'unsupported_media_type');

  const huge = await request(app).post('/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ login: 'admin', password: 'x'.repeat(40_000) }));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.code, 'body_too_large');

  // Inside the global ceiling but past this endpoint's own, much smaller, allowance.
  const overRouteLimit = await request(app).post('/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ login: 'admin', password: 'x'.repeat(8_000) }));
  assert.equal(overRouteLimit.status, 413);

  const malformed = await request(app).post('/auth/login').set('Content-Type', 'application/json').send('{"login":');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'invalid_json');
});

test('a password is bounded before it reaches a deliberately expensive hash', async () => {
  const { app } = await fixture();
  const response = await request(app).post('/auth/login').send({ login: 'admin', password: 'x'.repeat(1_000) });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'invalid_credentials_shape');
});

// --- CORS ---------------------------------------------------------------------------------------

test('only the configured origins are granted, and nothing is ever reflected or wildcarded', async () => {
  const { app } = await fixture();
  const allowed = await request(app).get('/health').set('Origin', ORIGIN);
  assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  assert.match(allowed.headers.vary, /Origin/);

  const hostile = await request(app).get('/health').set('Origin', 'https://huddle.example.com.attacker.test');
  assert.equal(hostile.headers['access-control-allow-origin'], undefined, 'a suffix of an allowed origin is not an allowed origin');
  assert.equal(hostile.status, 200, 'the browser refuses it; the API does not have to');

  const preflight = await request(app).options('/api/dashboard/1234').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'GET');
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /X-CSRF-Token/);
  assert.match(preflight.headers['access-control-expose-headers'], /X-Request-Id/);
  assert.match(preflight.headers['access-control-allow-methods'], /GET/);
  assert.ok(!/PUT|DELETE|PATCH/.test(preflight.headers['access-control-allow-methods']), 'methods this API does not serve fail at the preflight');

  const refusedPreflight = await request(app).options('/api/dashboard/1234').set('Origin', 'https://elsewhere.test').set('Access-Control-Request-Method', 'GET');
  assert.equal(refusedPreflight.headers['access-control-allow-origin'], undefined);
});

test('production cannot be built with no origin to fall back to', async () => {
  await assert.rejects(() => fixture({ production: true, webOrigins: [] }), CorsConfigurationError);
  // The development default is a real origin, not a wildcard: it grants localhost and nothing else.
  const { app } = await fixture({ production: false, webOrigins: ['http://localhost:5173'] });
  assert.equal((await request(app).get('/health').set('Origin', 'http://localhost:5173')).headers['access-control-allow-origin'], 'http://localhost:5173');
});

// --- Request ids --------------------------------------------------------------------------------

test('every response names a request, and a failure repeats it in the body', async () => {
  const { app } = await fixture();
  const missing = await request(app).get('/nothing-is-here');
  assert.equal(missing.status, 404);
  assert.ok(missing.headers['x-request-id']);
  assert.equal(missing.body.requestId, missing.headers['x-request-id']);
  assert.equal(missing.body.code, 'no_such_endpoint');
  // Two requests are two ids.
  assert.notEqual((await request(app).get('/health')).headers['x-request-id'], (await request(app).get('/health')).headers['x-request-id']);
});

test('an inbound request id is honoured only when it could not be writing the log or the header', async () => {
  const { app } = await fixture();
  const traced = await request(app).get('/health').set('X-Request-Id', 'lb-0f3a9c21-7788');
  assert.equal(traced.headers['x-request-id'], 'lb-0f3a9c21-7788');
  // Too short to be a trace, long enough to be someone writing our logs, and shaped to break the
  // line they would be written on. (A value carrying CRLF cannot be tested over the wire at all:
  // Node refuses to put one in a request header, which is the same protection from the other side.)
  for (const hostile of ['short', 'x'.repeat(200), 'has spaces', 'tab\tseparated', '{"json":"injected"}']) {
    const response = await request(app).get('/health').set('X-Request-Id', hostile);
    assert.notEqual(response.headers['x-request-id'], hostile);
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/, 'an unusable id is replaced with one of ours');
  }
});

// --- 4xx against 5xx ----------------------------------------------------------------------------

test('an upstream failure is classified by what the caller can do about it', () => {
  // The only upstream status the caller named something about.
  assert.equal(classify(new SleeperApiError(404, 'nope', 'not_found')).status, 404);
  // Throttling is ours to absorb, not the caller's to be blamed for.
  const throttled = classify(new SleeperApiError(429, 'slow down', 'rate_limit', true, 30_000));
  assert.equal(throttled.status, 503);
  assert.equal(throttled.retryAfterSeconds, 30);
  assert.equal(classify(new SleeperApiError(503, 'timed out', 'timeout', true)).status, 504);
  assert.equal(classify(new SleeperApiError(500, 'upstream broke', 'server', true)).status, 502);
  // A 4xx from upstream means we built a bad request; the caller cannot fix that by changing theirs.
  assert.equal(classify(new SleeperApiError(400, 'bad request', 'client')).status, 502);
  // An expired subscription key must be indistinguishable from an outage: one is a fact about us.
  const unauthorized = classify(new ProviderFetchError('sportsdataio', 401, 'unauthorized', 'unauthorized'));
  assert.equal(unauthorized.status, 502);
  assert.ok(!/auth|key|credential/i.test(unauthorized.message));
});

test('a defect in this application is a 500 that says nothing, and is logged as an error', async () => {
  const app = express();
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const log = { ...silentLogger, warn: (fields: Record<string, unknown>) => lines.push({ level: 'warn', fields }), error: (fields: Record<string, unknown>) => lines.push({ level: 'error', fields }) };
  app.get('/boom', () => { throw new TypeError("Cannot read properties of undefined (reading 'season') at /srv/huddle/dist/lineup.js"); });
  app.get('/refused', () => { throw new HttpError(400, 'Provide a week from 1 to 18.'); });
  app.use(errorHandler(log as never));

  const failed = await request(app).get('/boom');
  assert.equal(failed.status, 500, 'a bug here is not an upstream outage');
  assert.equal(failed.body.code, 'internal');
  assert.equal(failed.body.error, 'The request could not be completed.');
  assert.ok(!JSON.stringify(failed.body).includes('season'), 'the message stays in the log');
  assert.ok(!JSON.stringify(failed.body).includes('/srv/huddle'));
  assert.equal(lines.at(-1)!.level, 'error');

  const refused = await request(app).get('/refused');
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'Provide a week from 1 to 18.', 'a 4xx says what to fix');
  assert.equal(lines.at(-1)!.level, 'warn', 'a rejected request is not an incident');
});

// --- Rate limits --------------------------------------------------------------------------------

/** A minimal application, so the budgets under test are the ones written here. */
function limited(middleware: express.RequestHandler, authenticated?: { familyId: string }) {
  const app = express();
  app.set('trust proxy', true);
  if (authenticated) app.use((_req, res, next) => { res.locals.auth = { user: { id: 'u' }, session: { familyId: authenticated.familyId } }; next(); });
  app.get('/thing', middleware, (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler(silentLogger));
  return app;
}

test('one session exhausting its budget does not spend another session budget at the same address', async () => {
  resetRateLimits();
  const limit = rateLimit({ bucket: 'test-session', windowMs: 60_000, perSession: 2, perAddress: 100 });
  const first = limited(limit, { familyId: 'family-one' });
  const second = limited(limit, { familyId: 'family-two' });
  assert.equal((await request(first).get('/thing')).status, 200);
  assert.equal((await request(first).get('/thing')).status, 200);
  const exhausted = await request(first).get('/thing');
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.body.code, 'rate_limited');
  assert.ok(Number(exhausted.headers['retry-after']) > 0);
  assert.equal(exhausted.headers['ratelimit-remaining'], '0');
  // The other session is a different client and keeps its own allowance.
  assert.equal((await request(second).get('/thing')).status, 200);
});

test('an address budget bounds a caller with no session, and is charged even while another budget refuses', async () => {
  resetRateLimits();
  const app = limited(rateLimit({ bucket: 'test-address', windowMs: 60_000, perAddress: 3 }));
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt++) statuses.push((await request(app).get('/thing')).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('one session cannot keep an address budget intact by exhausting its own', async () => {
  resetRateLimits();
  const limit = rateLimit({ bucket: 'test-both', windowMs: 60_000, perSession: 1, perAddress: 3 });
  const one = limited(limit, { familyId: 'family-one' });
  const two = limited(limit, { familyId: 'family-two' });
  assert.equal((await request(one).get('/thing')).status, 200);
  // Refused on the session budget — and the address budget is charged for it anyway, which is what
  // stops a caller preserving one budget by deliberately overspending a cheaper one.
  assert.equal((await request(one).get('/thing')).status, 429);
  assert.equal((await request(two).get('/thing')).status, 200);
  assert.equal((await request(two).get('/thing')).status, 429, 'the address budget was spent by the refused request too');
});

test('an IPv6 caller is counted by allocation rather than by address', () => {
  const address = (ip: string) => clientAddress({ ip, socket: {} } as never);
  // Every address in a /64 is one caller: rotating inside one is not rotating at all.
  assert.equal(address('2001:db8:1:2:3:4:5:6'), address('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(address('2001:db8:1:2:3:4:5:6'), address('2001:db8:1:3:3:4:5:6'));
  // IPv4, including the form a dual-stack socket reports, is used whole.
  assert.equal(address('::ffff:203.0.113.7'), '203.0.113.7');
});

// --- Unmatched routes ---------------------------------------------------------------------------

test('an unknown route answers JSON rather than the framework HTML page', async () => {
  const { app, store } = await fixture();
  const session = await signedInAs(store, { sleeperUserId: 'sample', leagueIds: ['1234'] });
  const responses = [
    await request(app).post('/not-a-route'),
    // Under /api, where authentication runs before routing, an authenticated caller still has to
    // reach a 404 rather than the framework's HTML page.
    await request(app).post('/api/trades/1234').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken),
  ];
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.body.code, 'no_such_endpoint');
    assert.ok(!/<html|<pre/i.test(response.text));
  }
});
