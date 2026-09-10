import test from 'node:test'; import assert from 'node:assert/strict'; import request from 'supertest'; import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { setTimeout as delay } from 'node:timers/promises'; import { createApp } from './app.js'; import { JsonStore } from './store.js'; import { authDigest, passwordHash, sessionPolicy, validateAuthenticationConfig } from './auth.js'; import { resetRateLimits } from './rate-limit.js';

const PASSWORD = 'correct horse battery staple';
const sessionSettings = ['SESSION_TTL_HOURS', 'SESSION_IDLE_MINUTES', 'SESSION_ROTATE_MINUTES', 'SESSION_ROTATION_GRACE_SECONDS'] as const;
/** Rate limits and the session policy are process-wide, so each fixture starts from a known configuration. */
async function fixture(env: Partial<Record<(typeof sessionSettings)[number], string>> = {}) {
  resetRateLimits();
  for (const name of sessionSettings) delete process.env[name];
  Object.assign(process.env, env);
  process.env.ENABLE_DEMO_AUTH = 'true';
  const dir = await mkdtemp(join(tmpdir(), 'sleeper-'));
  const store = new JsonStore(join(dir, 'data.json'));
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: await passwordHash(PASSWORD), sleeperUserId: 'sample', sleeperLeagueIds: ['demo'], createdAt: new Date().toISOString() });
  return { store, app: createApp(store) };
}
const signIn = async (app: ReturnType<typeof createApp>, password = PASSWORD) => request(app).post('/auth/login').send({ login: 'admin', password });
const jar = (response: { headers: Record<string, unknown> }) => (response.headers['set-cookie'] as string[])[0].split(';')[0];

test('dashboard requires a session', async () => { const { app } = await fixture(); assert.equal((await request(app).get('/api/dashboard/demo')).status, 401); });

test('login issues hardened cookie and CSRF protects mutations', async () => {
  const { app } = await fixture(); const login = await signIn(app);
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /^__Host-huddle_session=/);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/); assert.match(login.headers['set-cookie'][0], /Secure/); assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  const cookie = jar(login);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie)).status, 403);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie).set('X-CSRF-Token', 'not-the-token')).status, 403);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken)).status, 200);
});

test('a CSRF token is only valid for the session it was issued to', async () => {
  const { app } = await fixture(); const first = await signIn(app), second = await signIn(app);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', jar(first)).set('X-CSRF-Token', second.body.csrfToken)).status, 403);
});

test('a reloaded page resumes from the cookie and receives a usable CSRF token', async () => {
  const { app } = await fixture(); const cookie = jar(await signIn(app));
  const resumed = await request(app).get('/auth/session').set('Cookie', cookie);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.user.login, 'admin');
  assert.ok(resumed.body.csrfToken);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie).set('X-CSRF-Token', resumed.body.csrfToken)).status, 200);
});

test('a second tab does not invalidate the first tab CSRF token', async () => {
  const { app } = await fixture(); const login = await signIn(app), cookie = jar(login);
  const secondTab = await request(app).get('/auth/session').set('Cookie', cookie);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie).set('X-CSRF-Token', secondTab.body.csrfToken)).status, 200);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken)).status, 200);
});

test('logout revokes the session', async () => {
  const { app } = await fixture(); const login = await signIn(app), cookie = jar(login);
  const logout = await request(app).post('/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken);
  assert.equal(logout.status, 204);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', cookie)).status, 401);
});

test('signing out everywhere revokes sessions issued to other clients', async () => {
  const { app } = await fixture(); const phone = await signIn(app), laptop = await signIn(app);
  assert.equal((await request(app).post('/auth/logout-all').set('Cookie', jar(laptop)).set('X-CSRF-Token', laptop.body.csrfToken)).status, 204);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', jar(phone))).status, 401);
});

test('sessions rotate, and replaying the retired id revokes the whole family', async () => {
  const { app } = await fixture({ SESSION_ROTATE_MINUTES: '0.0005', SESSION_ROTATION_GRACE_SECONDS: '0.05' });
  const login = await signIn(app), cookie = jar(login);
  await delay(60);
  const rotated = await request(app).get('/api/dashboard/demo').set('Cookie', cookie);
  assert.equal(rotated.status, 200);
  const replacement = jar(rotated);
  assert.notEqual(replacement, cookie);
  await delay(120);
  // Past the grace window the retired id can only be a copy, so every session in the family is retired with it.
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', cookie)).status, 401);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', replacement)).status, 401);
});

test('an explicit rotation keeps the session alive under a new id', async () => {
  const { app } = await fixture(); const login = await signIn(app), cookie = jar(login);
  const rotated = await request(app).post('/auth/rotate').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken);
  assert.equal(rotated.status, 200);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', jar(rotated)).set('X-CSRF-Token', rotated.body.csrfToken)).status, 200);
});

test('an idle session expires and use extends the idle window', async () => {
  const { app } = await fixture({ SESSION_IDLE_MINUTES: '0.02' });
  const idle = jar(await signIn(app));
  await delay(1_400);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', idle)).status, 401);
  const active = jar(await signIn(app));
  await delay(700);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', active)).status, 200);
  await delay(700);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', active)).status, 200);
});

test('the idle window never outlives the absolute session lifetime', async () => {
  const { app } = await fixture({ SESSION_TTL_HOURS: '0.0004', SESSION_IDLE_MINUTES: '60' });
  const cookie = jar(await signIn(app));
  assert.equal(sessionPolicy().idleMs, sessionPolicy().absoluteMs);
  await delay(1_600);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', cookie)).status, 401);
});

test('league authorization comes from the session, not the request', async () => {
  const { app } = await fixture(); const cookie = jar(await signIn(app));
  const denied = await request(app).get('/api/dashboard/99999').set('Cookie', cookie);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /not linked/);
  // A Sleeper user id supplied by the client is not an identity input either.
  assert.equal((await request(app).get('/api/sleeper/users/somebody-else/leagues').set('Cookie', cookie)).status, 403);
});

test('repeated failed sign-ins are rate limited', async () => {
  const { app } = await fixture();
  let last = await signIn(app, 'wrong');
  for (let attempt = 0; attempt < 11 && last.status !== 429; attempt++) last = await signIn(app, 'wrong');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  // The account budget outlives the address budget, so the correct password is refused too.
  assert.equal((await signIn(app)).status, 429);
});

test('demo authentication and demo data are unavailable when the opt-in is off', async () => {
  const { app, store } = await fixture();
  process.env.ENABLE_DEMO_AUTH = 'false';
  try {
    assert.equal((await request(app).post('/auth/demo')).status, 404);
    const cookie = jar(await signIn(app));
    // The user has 'demo' in their linked leagues, so authorization passes and only the demo gate refuses the data.
    assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', cookie)).status, 404);
    assert.equal(await store.snapshot('demo'), undefined);
  } finally { process.env.ENABLE_DEMO_AUTH = 'true'; }
});

test('expired and revoked sessions are pruned from the store', async () => {
  const { store, app } = await fixture(); const login = await signIn(app);
  const idHash = authDigest(decodeURIComponent(jar(login).split('=')[1]));
  assert.ok(await store.session(idHash));
  assert.equal(await store.pruneSessions(), 0);
  assert.equal(await store.pruneSessions(Date.now() + 30 * 24 * 60 * 60_000), 1);
  assert.equal(await store.session(idHash), undefined);
});

test('production refuses an unsafe configuration', () => {
  const base = { NODE_ENV: 'production', APP_LOGIN_PASSWORD_HASH: 'scrypt:ab:cd', WEB_ORIGIN: 'https://huddle.example.com' };
  assert.throws(() => validateAuthenticationConfig({ ...base, ENABLE_DEMO_AUTH: 'true' }), /demo authentication/);
  assert.throws(() => validateAuthenticationConfig({ ...base, INSECURE_DEV_COOKIES: 'true' }), /INSECURE_DEV_COOKIES/);
  assert.throws(() => validateAuthenticationConfig({ ...base, APP_LOGIN_PASSWORD_HASH: undefined }), /identity provider/);
  assert.throws(() => validateAuthenticationConfig({ ...base, APP_LOGIN_PASSWORD_HASH: 'plaintext' }), /scrypt hash/);
  assert.throws(() => validateAuthenticationConfig({ ...base, WEB_ORIGIN: undefined }), /WEB_ORIGIN/);
  assert.throws(() => validateAuthenticationConfig({ ...base, WEB_ORIGIN: 'http://huddle.example.com' }), /https/);
  assert.throws(() => validateAuthenticationConfig({ ...base, SESSION_TTL_HOURS: '0' }), /SESSION_TTL_HOURS/);
  assert.doesNotThrow(() => validateAuthenticationConfig(base));
  assert.doesNotThrow(() => validateAuthenticationConfig({ NODE_ENV: 'development', ENABLE_DEMO_AUTH: 'true', WEB_ORIGIN: 'http://localhost:5173' }));
});
