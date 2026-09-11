import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEnvironment, EnvironmentError, runtimeMode, validateEnvironment } from './environment.js';
import { parseWebOrigins, webOrigins } from './origins.js';

/** A configuration a production deployment would actually be given, for tests to break one field of. */
const production = {
  NODE_ENV: 'production',
  PORT: '4000',
  WEB_ORIGIN: 'https://huddle.example.com',
  APP_LOGIN_USER: 'admin',
  APP_LOGIN_PASSWORD_HASH: 'scrypt:ab12:cd34',
  STORAGE_ADAPTER: 'postgres',
  DATABASE_URL: 'postgres://huddle:secret@db.internal:5432/huddle',
  APP_INSTANCE_MODE: 'multi',
  SYNC_WORKER_ENABLED: 'false',
  TRUST_PROXY: '1',
  WAIVER_SIGNALS_PATH: '/srv/huddle/waiver-signals.json',
} satisfies NodeJS.ProcessEnv;

const problems = (env: NodeJS.ProcessEnv): string[] => {
  try { validateEnvironment(env); return []; }
  catch (error) { assert.ok(error instanceof EnvironmentError); return error.problems; }
};
const matching = (env: NodeJS.ProcessEnv, pattern: RegExp) => problems(env).filter(problem => pattern.test(problem));

test('a complete production configuration is accepted and summarized without secrets', () => {
  const configuration = validateEnvironment(production);
  assert.equal(configuration.mode, 'production');
  assert.equal(configuration.production, true);
  assert.equal(configuration.port, 4000);
  assert.deepEqual(configuration.webOrigins, ['https://huddle.example.com']);
  assert.equal(configuration.storage.adapter, 'postgres');
  assert.equal(configuration.storage.instanceMode, 'multi');
  assert.equal(configuration.sync.workerEnabled, false);
  assert.equal(configuration.trustProxy, 1);

  const summary = describeEnvironment(configuration);
  assert.match(summary, /mode=production/);
  assert.match(summary, /storage=postgres\/multi/);
  assert.doesNotMatch(summary, /secret/, 'the summary must never carry the database password');
});

test('every problem is reported in one pass rather than one per restart', () => {
  const found = problems({ ...production, PORT: 'four thousand', WEB_ORIGIN: 'http://huddle.example.com', SYNC_CONCURRENCY: 'ten' });
  assert.ok(found.length >= 3, `expected several problems, got ${JSON.stringify(found)}`);
  assert.ok(found.some(problem => /PORT/.test(problem)));
  assert.ok(found.some(problem => /SYNC_CONCURRENCY/.test(problem)));
  assert.ok(found.some(problem => /https/.test(problem)));
  // The combined message lists each one, so a deployment learns all of them at once.
  const error = new EnvironmentError(found);
  for (const problem of found) assert.ok(error.message.includes(problem.replace(/^Refusing to start:\s*/, '')));
});

test('a runtime mode that is not one of the three disables every production safeguard, so it is refused', () => {
  assert.equal(runtimeMode({}), 'development');
  assert.equal(runtimeMode({ NODE_ENV: 'production' }), 'production');
  assert.throws(() => runtimeMode({ NODE_ENV: 'prod' }), /NODE_ENV/);
  assert.throws(() => runtimeMode({ NODE_ENV: 'Production' }), /NODE_ENV/);
  assert.ok(matching({ ...production, NODE_ENV: 'staging' }, /NODE_ENV/).length);
});

test('a port that cannot be parsed is refused rather than becoming a random free port', () => {
  for (const port of ['', ' ']) assert.equal(validateEnvironment({ ...production, PORT: port }).port, 4000);
  for (const port of ['nope', '0', '-1', '70000', '4000.5']) assert.ok(matching({ ...production, PORT: port }, /PORT/).length, `expected ${port} to be refused`);
  assert.equal(validateEnvironment({ ...production, PORT: '8080' }).port, 8080);
});

test('a flag that is neither true nor false is refused, because it is read as one and does the other', () => {
  assert.ok(matching({ ...production, SYNC_WORKER_ENABLED: 'no' }, /SYNC_WORKER_ENABLED/).length);
  assert.ok(matching({ ...production, SYNC_WORKER_ENABLED: '0' }, /SYNC_WORKER_ENABLED/).length);
  assert.ok(matching({ ...production, PROJECTION_FEED_ENABLED: 'yes' }, /PROJECTION_FEED_ENABLED/).length);
  assert.equal(validateEnvironment({ ...production, SYNC_WORKER_ENABLED: 'TRUE' }).sync.workerEnabled, true);
});

test('origins are exact, credential-free and https outside local development', () => {
  assert.deepEqual(parseWebOrigins('https://a.example.com, https://b.example.com', { production: true }), ['https://a.example.com', 'https://b.example.com']);
  assert.deepEqual(parseWebOrigins('https://a.example.com,https://a.example.com', { production: true }), ['https://a.example.com'], 'duplicates collapse');
  assert.deepEqual(parseWebOrigins(undefined, { production: false }), []);
  // A path looks like it narrows the grant and does not: the browser never sends it.
  assert.throws(() => parseWebOrigins('https://huddle.example.com/app', { production: true }), /path, query or fragment/);
  assert.throws(() => parseWebOrigins('https://user:pass@huddle.example.com', { production: true }), /credentials/);
  assert.throws(() => parseWebOrigins('huddle.example.com', { production: true }), /absolute origin/);
  assert.throws(() => parseWebOrigins('http://huddle.example.com', { production: true }), /https/);
  assert.doesNotThrow(() => parseWebOrigins('http://localhost:5173', { production: false }));
  assert.throws(() => parseWebOrigins('http://localhost:5173', { production: true }), /https/);
  assert.deepEqual(webOrigins({}), ['http://localhost:5173'], 'development falls back to the dev server origin');
  assert.deepEqual(validateEnvironment({ ...production, WEB_ORIGIN: 'https://a.example.com,https://b.example.com' }).webOrigins, ['https://a.example.com', 'https://b.example.com']);
});

test('the database URL is checked for shape, and never quoted back', () => {
  assert.ok(matching({ ...production, DATABASE_URL: 'psql postgres://db/huddle' }, /DATABASE_URL/).length);
  assert.ok(matching({ ...production, DATABASE_URL: 'mysql://db.internal:3306/huddle' }, /postgres:\/\//).length);
  assert.ok(matching({ ...production, DATABASE_URL: 'postgres://db.internal:5432' }, /names no database/).length);
  for (const problem of problems({ ...production, DATABASE_URL: 'not a url with secret=hunter2 in it' })) {
    assert.doesNotMatch(problem, /hunter2/, 'a malformed connection string must not be echoed: it carries a password');
  }
  // A missing URL is the storage layer's own refusal, reported once rather than twice.
  assert.equal(matching({ ...production, DATABASE_URL: undefined }, /DATABASE_URL/).length, 1);
});

test('the session login must match what sign-in looks up', () => {
  assert.ok(matching({ ...production, APP_LOGIN_USER: 'Admin' }, /APP_LOGIN_USER/).length, 'an uppercase login seeds an account nothing can sign in to');
  assert.ok(matching({ ...production, APP_LOGIN_USER: ' admin' }, /APP_LOGIN_USER/).length);
  assert.ok(matching({ ...production, APP_LOGIN_USER: '' }, /APP_LOGIN_USER/).length);
  assert.ok(matching({ ...production, APP_LOGIN_PASSWORD_HASH: 'plaintext' }, /scrypt/).length);
  assert.ok(matching({ NODE_ENV: 'development', APP_LOGIN_PASSWORD_HASH: 'plaintext' }, /scrypt/).length, 'a malformed hash outside production only shows up as a password that is always wrong');
  assert.ok(matching({ ...production, SESSION_TTL_HOURS: '0' }, /SESSION_TTL_HOURS/).length);
  assert.ok(matching({ ...production, SESSION_ROTATE_MINUTES: '-5' }, /SESSION_ROTATE_MINUTES/).length);
});

test('intervals are refused when they are unparseable or contradict each other', () => {
  assert.ok(matching({ ...production, SYNC_INTERVAL_MINUTES: '0' }, /SYNC_INTERVAL_MINUTES/).length);
  assert.ok(matching({ ...production, SYNC_CONCURRENCY: '2.5' }, /SYNC_CONCURRENCY/).length);
  assert.ok(matching({ ...production, SYNC_JITTER_SECONDS: '-1' }, /SYNC_JITTER_SECONDS/).length);
  assert.ok(matching({ ...production, SYNC_LEASE_MINUTES: 'ten' }, /SYNC_LEASE_MINUTES/).length);
  assert.ok(matching({ ...production, SHUTDOWN_GRACE_SECONDS: '0' }, /SHUTDOWN_GRACE_SECONDS/).length);
  // A ceiling below the first delay means every retry clamps to it, so the backoff never grows.
  assert.ok(matching({ ...production, SYNC_RETRY_BASE_SECONDS: '600', SYNC_RETRY_MAX_MINUTES: '5' }, /SYNC_RETRY_MAX_MINUTES/).length);
  assert.equal(problems({ ...production, SYNC_RETRY_BASE_SECONDS: '60', SYNC_RETRY_MAX_MINUTES: '60' }).length, 0);
  assert.equal(validateEnvironment({ ...production, SYNC_INTERVAL_MINUTES: '15' }).sync.intervalMs, 15 * 60_000);
});

test('enabling the forecast feed without a credential is refused at startup', () => {
  assert.ok(matching({ ...production, PROJECTION_FEED_ENABLED: 'true' }, /SPORTSDATAIO_API_KEY/).length);
  assert.ok(matching({ ...production, PROJECTION_FEED_ENABLED: 'true', SPORTSDATAIO_API_KEY: 'your-subscription-key' }, /placeholder/).length);
  const enabled = validateEnvironment({ ...production, PROJECTION_FEED_ENABLED: 'true', SPORTSDATAIO_API_KEY: 'a-real-key' });
  assert.equal(enabled.projectionFeed.enabled, true);
  assert.equal(enabled.projectionFeed.credentialConfigured, true);
  assert.ok(!JSON.stringify(enabled).includes('a-real-key'), 'the configuration must carry whether there is a credential, never the credential');
});

test('forecast thresholds, the alert webhook, the time zone and the signals path are checked', () => {
  assert.ok(matching({ ...production, PROJECTION_FEED_MIN_IDENTITY_MATCH: '95' }, /PROJECTION_FEED_MIN_IDENTITY_MATCH/).length);
  assert.ok(matching({ ...production, PROJECTION_FEED_MIN_PLAYERS: '30.5' }, /PROJECTION_FEED_MIN_PLAYERS/).length);
  assert.ok(matching({ ...production, PROJECTION_FEED_ALERT_WEBHOOK: 'http://alerts.internal/hook' }, /https/).length);
  assert.ok(matching({ ...production, PROJECTION_FEED_TIME_ZONE: 'America/Nowhere' }, /IANA time zone/).length);
  assert.ok(matching({ ...production, NFL_SEASON: '25' }, /NFL_SEASON/).length);
  assert.ok(matching({ ...production, NFL_WEEK_ONE_TUESDAY: 'labor day' }, /NFL_WEEK_ONE_TUESDAY/).length);
  assert.ok(matching({ ...production, WAIVER_SIGNALS_PATH: '../../data/waiver-signals.json' }, /absolute path/).length);
});

test('the worker health probe is off unless a port is named, and cannot collide with the API port', () => {
  assert.equal(validateEnvironment(production).workerHealthPort, undefined);
  assert.equal(validateEnvironment({ ...production, WORKER_HEALTH_PORT: '4010' }).workerHealthPort, 4010);
  assert.ok(matching({ ...production, WORKER_HEALTH_PORT: 'health' }, /WORKER_HEALTH_PORT/).length);
  assert.ok(matching({ ...production, PORT: '4000', WORKER_HEALTH_PORT: '4000' }, /only one of them can bind it/).length);
});

test('the proxy count is validated rather than handed to Express to interpret', () => {
  assert.equal(validateEnvironment({ ...production, TRUST_PROXY: undefined }).trustProxy, false);
  assert.equal(validateEnvironment({ ...production, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(validateEnvironment({ ...production, TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(validateEnvironment({ ...production, TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(validateEnvironment({ ...production, TRUST_PROXY: '10.0.0.0/8, 192.168.0.1' }).trustProxy, '10.0.0.0/8, 192.168.0.1');
  assert.ok(matching({ ...production, TRUST_PROXY: 'yes' }, /TRUST_PROXY/).length);
});

test('storage refusals still apply, and their warnings are carried rather than swallowed', () => {
  assert.ok(matching({ NODE_ENV: 'production', WEB_ORIGIN: 'https://huddle.example.com', APP_LOGIN_PASSWORD_HASH: 'scrypt:ab:cd' }, /STORAGE_ADAPTER/).length, 'production must name its adapter');
  assert.ok(matching({ ...production, STORAGE_ADAPTER: 'json' }, /JSON adapter/).length, 'a file cannot back a multi-instance production deployment');
  const single = validateEnvironment({ ...production, STORAGE_ADAPTER: 'json', APP_INSTANCE_MODE: 'single', DATABASE_URL: undefined });
  assert.ok(single.warnings.some(warning => /local development profile/.test(warning)));
});

test('a deployment with no forecast source at all is a warning, not a refusal', () => {
  const configuration = validateEnvironment({ ...production, WAIVER_SIGNALS_PATH: undefined });
  assert.ok(configuration.warnings.some(warning => /No forecast source/.test(warning)));
});

test('a production deployment with no proxy configured is warned that rate limits share one bucket', () => {
  const configuration = validateEnvironment({ ...production, TRUST_PROXY: undefined });
  assert.ok(configuration.warnings.some(warning => /TRUST_PROXY/.test(warning)));
});

test('demo authentication stays a development affordance whatever the flag says', () => {
  assert.ok(matching({ ...production, ENABLE_DEMO_AUTH: 'true' }, /demo authentication/).length);
  assert.equal(validateEnvironment({ NODE_ENV: 'development', ENABLE_DEMO_AUTH: 'true' }).demoEnabled, true);
  assert.equal(validateEnvironment({ NODE_ENV: 'development' }).demoEnabled, false);
});
