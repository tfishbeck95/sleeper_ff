import assert from 'node:assert/strict';
import test from 'node:test';
import { onSessionEnded, post, request, resumeSession, setCsrfToken, signOut } from './api';

interface Call { url: string; method: string; csrf: string | undefined }
function stubFetch(reply: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(url), method: init?.method ?? 'GET', csrf: headers['X-CSRF-Token'] };
    calls.push(call);
    const { status, body = null } = reply(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}
const quiet = () => onSessionEnded(() => undefined);

test('a reloaded page resumes from the cookie and mutates with the token it is handed', async () => {
  quiet(); setCsrfToken('');
  const calls = stubFetch(call => call.url.endsWith('/auth/session') ? { status: 200, body: { user: { id: 'u1', login: 'admin', sleeperLeagueIds: ['1234'] }, csrfToken: 'fresh-token' } } : { status: 200, body: { ok: true } });
  const user = await resumeSession();
  assert.equal(user?.login, 'admin');
  await post('/api/sync/1234', {});
  assert.equal(calls[1].csrf, 'fresh-token');
});

test('no live session resumes as signed out rather than as an error', async () => {
  quiet(); setCsrfToken('');
  stubFetch(() => ({ status: 401, body: { error: 'Authentication required.' } }));
  assert.equal(await resumeSession(), null);
});

test('a rejected session ends the shell session and discards the CSRF token', async () => {
  let ended = 0;
  onSessionEnded(() => { ended++; });
  setCsrfToken('stale-token');
  const calls = stubFetch(call => call.url.endsWith('/api/dashboard/1234') ? { status: 401, body: { error: 'Session expired. Sign in again.' } } : { status: 200, body: {} });
  await assert.rejects(request('/api/dashboard/1234'), /Session expired/);
  assert.equal(ended, 1);
  await post('/api/sync/1234', {});
  assert.equal(calls[1].csrf, '');
  quiet();
});

test('signing out revokes on the server and drops the token locally', async () => {
  quiet(); setCsrfToken('live-token');
  const calls = stubFetch(() => ({ status: 204 }));
  await signOut();
  assert.equal(calls[0].url.endsWith('/auth/logout'), true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].csrf, 'live-token');
  await post('/api/sync/1234', {});
  assert.equal(calls[1].csrf, '');
});
