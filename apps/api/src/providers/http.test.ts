import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderFetchError, ProviderHttpClient, requireCredential, retryAfterMs } from './http.js';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const isArray = (value: unknown) => Array.isArray(value);
const client = (responses: Array<() => Response>, waits: number[] = []) => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    const next = responses[Math.min(index, responses.length - 1)]; index += 1;
    return next();
  }) as unknown as typeof fetch;
  return { calls, client: new ProviderHttpClient('Test source', fetcher, { backoffMs: 1, maxBackoffMs: 1 }, async ms => { waits.push(ms); }), get index() { return index; } };
};

test('a transient server error is retried and the eventual success is returned', async () => {
  const harness = client([() => json({ error: 'boom' }, 500), () => json({ error: 'boom' }, 500), () => json([{ ok: true }])]);
  assert.deepEqual(await harness.client.getJson('https://example.invalid/x', isArray), [{ ok: true }]);
  assert.equal(harness.index, 3);
});

test('a rejected credential is never retried, because a second attempt spends quota on the same wrong key', async () => {
  const harness = client([() => json({ error: 'unauthorized' }, 401)]);
  await assert.rejects(
    () => harness.client.getJson('https://example.invalid/x', isArray),
    (error: ProviderFetchError) => error.category === 'unauthorized' && error.retryable === false,
  );
  assert.equal(harness.index, 1);
});

test('a 404 is a missing resource, not an outage, and is not retried', async () => {
  const harness = client([() => json({}, 404)]);
  await assert.rejects(() => harness.client.getJson('https://example.invalid/x', isArray), (error: ProviderFetchError) => error.category === 'not_found');
  assert.equal(harness.index, 1);
});

test('Retry-After is honoured in preference to the backoff schedule', async () => {
  const waits: number[] = [];
  const harness = client([() => json({}, 429, { 'Retry-After': '7' }), () => json([])], waits);
  await harness.client.getJson('https://example.invalid/x', isArray);
  assert.deepEqual(waits, [7000], 'the source said how long to wait, so backing off less would be rate-limited harder');
});

test('Retry-After accepts both forms and ignores an implausible one', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  assert.equal(retryAfterMs('30', now), 30_000);
  assert.equal(retryAfterMs(new Date(now + 45_000).toUTCString(), now), 45_000);
  assert.equal(retryAfterMs('999999', now), null);
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs('nonsense', now), null);
});

test('retries give up after the configured number of attempts', async () => {
  const harness = client([() => json({}, 503)]);
  await assert.rejects(() => harness.client.getJson('https://example.invalid/x', isArray), (error: ProviderFetchError) => error.category === 'server');
  assert.equal(harness.index, 4, 'the initial attempt plus three retries');
});

test('a 200 carrying the wrong shape is a validation failure, and retrying it would not help', async () => {
  const harness = client([() => json({ message: 'no data for this week' })]);
  await assert.rejects(
    () => harness.client.getJson('https://example.invalid/x', isArray),
    (error: ProviderFetchError) => error.category === 'validation' && /unexpected response shape/.test(error.message),
  );
  assert.equal(harness.index, 1);
});

test('an empty body is refused rather than parsed into an empty feed', async () => {
  const harness = client([() => new Response('   ', { status: 200 })]);
  await assert.rejects(() => harness.client.getText('https://example.invalid/x'), (error: ProviderFetchError) => error.category === 'validation');
});

test('credentials travel in a header and never appear in the URL', async () => {
  const harness = client([() => json([])]);
  await harness.client.getJson('https://example.invalid/projections', isArray, { 'Ocp-Apim-Subscription-Key': 'secret-key' });
  assert.equal(harness.calls[0].headers.get('Ocp-Apim-Subscription-Key'), 'secret-key');
  assert.ok(!harness.calls[0].url.includes('secret-key'), 'a query string reaches proxy logs and error reports intact');
});

test('a thrown fetch error never carries the credential into its message', async () => {
  const harness = client([() => json({}, 401)]);
  await harness.client.getJson('https://example.invalid/x', isArray, { 'Ocp-Apim-Subscription-Key': 'secret-key' }).catch((error: ProviderFetchError) => {
    assert.ok(!error.message.includes('secret-key'));
    assert.equal(error.source, 'Test source');
  });
});

test('a missing credential fails loudly, naming the variable to set', () => {
  assert.throws(() => requireCredential('SPORTSDATAIO_API_KEY', {}), /SPORTSDATAIO_API_KEY is not set/);
  assert.throws(() => requireCredential('SPORTSDATAIO_API_KEY', { SPORTSDATAIO_API_KEY: '   ' }), /is not set/);
  assert.equal(requireCredential('SPORTSDATAIO_API_KEY', { SPORTSDATAIO_API_KEY: ' key ' }), 'key');
});

test('an abort stops the retry loop instead of running it to exhaustion', async () => {
  const controller = new AbortController();
  const harness = client([() => { controller.abort(); return json({}, 503); }]);
  await assert.rejects(() => harness.client.getJson('https://example.invalid/x', isArray, {}, controller.signal));
  assert.equal(harness.index, 1);
});
