import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetryAfter, SleeperApiError, SleeperClient } from './index.js';

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
}) as unknown as Response;

test('Retry-After is read in both documented forms, and never as a negative or a guess', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(parseRetryAfter('60', now), 60_000);
  assert.equal(parseRetryAfter(' 0 ', now), 0);
  assert.equal(parseRetryAfter('Tue, 06 Oct 2026 12:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfter('Tue, 06 Oct 2026 11:58:00 GMT', now), 0, 'a date already past is now, not a negative wait');
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('-30', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('upstream retry guidance is honoured inside the request budget and handed back beyond it', async () => {
  let calls = 0;
  const brief = new SleeperClient(async () => (calls++ === 0 ? response(429, null, { 'retry-after': '0' }) : response(200, { league_id: 'l1' })), 'https://sleeper.test', { maxRetryAfterMs: 5_000 });
  assert.deepEqual(await brief.league('l1'), { league_id: 'l1' });
  assert.equal(calls, 2, 'a delay this request can absorb is simply waited out');

  // A minute is not something to hold an HTTP request open for: the error carries the guidance so the
  // background worker can schedule the next attempt when Sleeper asked for it.
  let long = 0;
  const client = new SleeperClient(async () => { long++; return response(429, null, { 'retry-after': '60' }); }, 'https://sleeper.test');
  const error = await client.league('l1').then(() => null, (value: unknown) => value as SleeperApiError);
  assert.ok(error instanceof SleeperApiError);
  assert.equal(error.category, 'rate_limit');
  assert.equal(error.retryAfterMs, 60_000);
  assert.equal(long, 1, 'no retry is attempted against a limit that has not expired');
});

test('a failure without guidance still backs off and is categorized', async () => {
  let calls = 0;
  const client = new SleeperClient(async () => { calls++; return response(503, null); }, 'https://sleeper.test', { maxRetries: 1, backoffMs: 0 });
  const error = await client.rosters('l1').then(() => null, (value: unknown) => value as SleeperApiError);
  assert.ok(error instanceof SleeperApiError);
  assert.equal(error.category, 'server');
  assert.equal(error.retryAfterMs, null);
  assert.equal(calls, 2);
});
