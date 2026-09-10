import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { JsonStore } from './store.js';
import { passwordHash, validateAuthenticationConfig } from './auth.js';

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sleeper-'));
  const store = new JsonStore(join(dir, 'data.json'));
  await store.saveApplicationUser({ id: 'u1', login: 'admin', passwordHash: await passwordHash('correct horse battery staple'), sleeperUserId: 'sample', sleeperLeagueIds: ['demo'], createdAt: new Date().toISOString() });
  return { store, app: createApp(store) };
};
const signIn = async (app: ReturnType<typeof createApp>) => {
  const response = await request(app).post('/auth/login').send({ login: 'admin', password: 'correct horse battery staple' });
  return { response, cookie: response.headers['set-cookie'][0].split(';')[0] };
};
const idHash = (cookie: string) => createHash('sha256').update(cookie.split('=')[1]).digest('hex');

test('protected APIs require an application session', async () => {
  const { app } = await fixture();
  assert.equal((await request(app).get('/api/dashboard/demo')).status, 401);
});

test('login issues a hardened cookie and session can be restored after reload', async () => {
  const { app } = await fixture();
  const { response, cookie } = await signIn(app);
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /^__Host-huddle_session=/);
  for (const attribute of [/HttpOnly/, /Secure/, /SameSite=Strict/, /Path=\//]) assert.match(response.headers['set-cookie'][0], attribute);
  const restored = await request(app).get('/auth/session').set('Cookie', cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.csrfToken, response.body.csrfToken);
  assert.equal(restored.headers['cache-control'], 'no-store');
});

test('CSRF protects mutations and rotation revokes the old session', async () => {
  const { app } = await fixture();
  const { response, cookie } = await signIn(app);
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', cookie)).status, 403);
  const rotated = await request(app).post('/auth/rotate').set('Cookie', cookie).set('X-CSRF-Token', response.body.csrfToken);
  assert.equal(rotated.status, 200);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', cookie)).status, 401);
  const rotatedCookie = rotated.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(app).post('/api/sync/demo').set('Cookie', rotatedCookie).set('X-CSRF-Token', rotated.body.csrfToken)).status, 200);
});

test('logout and administrative revocation invalidate sessions', async () => {
  const { app, store } = await fixture();
  const first = await signIn(app);
  assert.equal((await request(app).post('/auth/logout').set('Cookie', first.cookie).set('X-CSRF-Token', first.response.body.csrfToken)).status, 204);
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', first.cookie)).status, 401);
  const second = await signIn(app);
  await store.revokeUserSessions('u1');
  assert.equal((await request(app).get('/api/dashboard/demo').set('Cookie', second.cookie)).status, 401);
});

test('expired sessions are rejected and their cookie is cleared', async () => {
  const { app, store } = await fixture();
  const { cookie } = await signIn(app);
  const session = await store.session(idHash(cookie));
  await store.saveSession({ ...session, expiresAt: new Date(0).toISOString() });
  const response = await request(app).get('/api/dashboard/demo').set('Cookie', cookie);
  assert.equal(response.status, 401);
  assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
});

test('production authentication configuration fails closed', async () => {
  assert.throws(() => validateAuthenticationConfig({ NODE_ENV: 'production', ENABLE_DEMO_AUTH: 'true' }), /demo authentication/);
  assert.throws(() => validateAuthenticationConfig({ NODE_ENV: 'production' }), /APP_LOGIN_PASSWORD_HASH/);
  assert.throws(() => validateAuthenticationConfig({ APP_LOGIN_PASSWORD_HASH: 'not-a-hash' }), /valid generated scrypt hash/);
  const hash = await passwordHash('correct horse battery staple');
  assert.doesNotThrow(() => validateAuthenticationConfig({ NODE_ENV: 'production', APP_LOGIN_PASSWORD_HASH: hash, SESSION_TTL_HOURS: '24' }));
});
