import test from 'node:test';
import assert from 'node:assert/strict';
import { SleeperApiError, SleeperClient } from '@sleeper/sleeper-client';
import { ProviderFetchError, ProviderHttpClient } from '../providers/http.js';
import { DEFAULT_UPSTREAM_BUDGETS, describeUpstreamBudgets, providerHttpOptions, resolveUpstreamBudgets, resetUpstreamBudgets, sleeperClient, upstreamBudgets } from './upstream.js';

/**
 * The budgets, and the property that makes them budgets: a whole call cannot outlive the total,
 * whatever the per-attempt timeout and the retry count multiply out to.
 */

test('both upstream clients are built from the same named budgets', () => {
  resetUpstreamBudgets();
  const budgets = upstreamBudgets({});
  assert.deepEqual(budgets, DEFAULT_UPSTREAM_BUDGETS);
  // A person is waiting on an interactive call and nobody is waiting on a background one, so the
  // background profile is allowed more attempts and far more total time.
  assert.ok(budgets.interactive.maxElapsedMs < budgets.background.maxElapsedMs);
  assert.ok(budgets.interactive.maxAttempts <= budgets.background.maxAttempts);
  // The provider client is configured from the same table rather than from its own constants.
  assert.deepEqual(providerHttpOptions('background', {}, {}), {
    timeoutMs: budgets.background.timeoutMs,
    maxRetries: budgets.background.maxAttempts - 1,
    backoffMs: budgets.background.backoffMs,
    maxBackoffMs: budgets.background.maxBackoffMs,
    maxElapsedMs: budgets.background.maxElapsedMs,
  });
  assert.ok(sleeperClient('interactive', fetch, {}) instanceof SleeperClient);
  assert.match(describeUpstreamBudgets(budgets), /interactive=10s×3\/20s/);
});

test('the environment moves the budgets, and a call-site override still yields to the profile', () => {
  const budgets = resolveUpstreamBudgets({ UPSTREAM_TIMEOUT_SECONDS: '4', UPSTREAM_MAX_ATTEMPTS: '2', UPSTREAM_REQUEST_BUDGET_SECONDS: '9', UPSTREAM_BACKGROUND_BUDGET_SECONDS: '120' });
  assert.equal(budgets.interactive.timeoutMs, 4_000);
  assert.equal(budgets.interactive.maxAttempts, 2);
  assert.equal(budgets.interactive.maxElapsedMs, 9_000);
  assert.equal(budgets.background.maxElapsedMs, 120_000);
  // An unparseable value is not silently a zero-length budget; `validateEnvironment` refuses it, and
  // the resolver falls back rather than producing one no call could ever complete inside.
  assert.equal(resolveUpstreamBudgets({ UPSTREAM_TIMEOUT_SECONDS: 'soon' }).interactive.timeoutMs, DEFAULT_UPSTREAM_BUDGETS.interactive.timeoutMs);
  assert.equal(resolveUpstreamBudgets({ UPSTREAM_MAX_ATTEMPTS: '0' }).interactive.maxAttempts, DEFAULT_UPSTREAM_BUDGETS.interactive.maxAttempts);
});

test('a Sleeper call stops retrying once the total budget cannot hold another attempt', async () => {
  let attempts = 0;
  const started = Date.now();
  // Every attempt fails in a way that is retryable, so only the budget can stop the loop.
  const failing: typeof fetch = async () => { attempts++; return new Response('', { status: 503 }); };
  const client = new SleeperClient(failing, 'https://upstream.test', { timeoutMs: 50, maxRetries: 20, backoffMs: 30, maxRetryAfterMs: 5_000, maxElapsedMs: 300 });
  await assert.rejects(() => client.league('1234'), SleeperApiError);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `the call must end with the budget, took ${elapsed}ms`);
  assert.ok(attempts > 1, 'it still retried');
  assert.ok(attempts < 21, `it stopped short of the retry count, at ${attempts} attempts`);
});

test("a provider call honours Retry-After only while it fits inside what is left of the budget", async () => {
  let attempts = 0;
  const slept: number[] = [];
  // Upstream asks for a minute; the budget is two seconds, so waiting would spend the whole window
  // on an attempt that gets aborted the moment it starts.
  const throttled: typeof fetch = async () => { attempts++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); };
  const client = new ProviderHttpClient('test-source', throttled, { timeoutMs: 100, maxRetries: 5, backoffMs: 10, maxBackoffMs: 100, maxElapsedMs: 2_000 }, async ms => { slept.push(ms); });
  await assert.rejects(() => client.getJson('https://upstream.test/feed', () => true), ProviderFetchError);
  assert.equal(attempts, 1, 'it did not sleep past its own deadline to try again');
  assert.deepEqual(slept, []);
});

test('a retry that fits is still taken', async () => {
  let attempts = 0;
  const flaky: typeof fetch = async () => (++attempts === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const client = new ProviderHttpClient('test-source', flaky, { timeoutMs: 500, maxRetries: 3, backoffMs: 5, maxBackoffMs: 10, maxElapsedMs: 5_000 }, async () => {});
  assert.deepEqual(await client.getJson('https://upstream.test/feed', () => true), { ok: true });
  assert.equal(attempts, 2);
});
