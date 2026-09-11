import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, identify, redact, redactString, REDACTED, type LogLevel } from './log.js';

/** Captures what would have been written, so a test reads exactly what an aggregator would. */
function recorder() {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({ level: 'debug', includeStack: true, now: () => new Date('2026-09-11T00:00:00.000Z'), write: (_level: LogLevel, line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }, {});
  return { log, lines };
}

test('a session token never reaches a log line, whatever it is called or nested inside', () => {
  const { log, lines } = recorder();
  // The real shapes: 43 characters of base64url from `randomBytes(32)`, and its sha256 digest.
  const rawSessionId = 'sSsCUwLRlSzRmnyXPnStHxXyYWLtmbGPvKXHXiZDhCE';
  const idHash = 'a'.repeat(64);
  log.info({ rawSessionId, session: { idHash, csrfHashes: [idHash] }, note: `resumed with ${rawSessionId}` }, 'session resumed');
  const [line] = lines;
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes(rawSessionId), 'the token must not appear anywhere in the line');
  assert.ok(!serialized.includes(idHash), 'nor its digest, which authenticates just as well');
  // Redacted by name where it has one, and by shape where it is buried in prose.
  assert.equal(line.rawSessionId, REDACTED);
  assert.match(String(line.note), /resumed with \[redacted\]/);
});

test('a provider credential is removed whether it is a field, a header or part of a URL', () => {
  const { log, lines } = recorder();
  log.error({
    apiKey: 'live_9f8e7d6c5b4a39281706',
    headers: { 'Ocp-Apim-Subscription-Key': 'a-licensed-key' },
    url: 'https://api.sportsdata.io/v3/nfl/projections?key=a-licensed-key',
    databaseUrl: 'postgres://huddle:hunter2@db.internal:5432/huddle',
  }, 'ingestion failed');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('a-licensed-key'));
  assert.ok(!serialized.includes('hunter2'));
  assert.equal(lines[0]!.apiKey, REDACTED);
  // The host and path stay: which endpoint failed is the diagnostic, the query is the credential.
  assert.equal(lines[0]!.url, `https://api.sportsdata.io/v3/nfl/projections?${REDACTED}`);
});

test('a filesystem path is removed from a field and from the error message that carries it', () => {
  const { log, lines } = recorder();
  const failure = Object.assign(new Error("ENOENT: no such file or directory, open '/var/lib/huddle/store.json'"), { code: 'ENOENT' });
  log.error({ dataFile: '/var/lib/huddle/store.json', error: failure }, 'storage failure');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('/var/lib/huddle'), 'the deployment layout is not published to whoever reads the logs');
  assert.equal(lines[0]!.dataFile, REDACTED);
  // What is left is still enough to act on: the syscall failure class, and which error it was.
  assert.equal((lines[0]!.error as Record<string, unknown>).code, 'ENOENT');
  assert.match(String((lines[0]!.error as Record<string, unknown>).message), /no such file or directory/);
});

test('a person is a stable digest rather than a name, and their settings are not written down at all', () => {
  const { log, lines } = recorder();
  log.info({ login: 'admin', sleeperUsername: 'the-commissioner', settings: { waiverBudget: 100 }, scoringSettings: { rec: 1 } }, 'account linked');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('the-commissioner'));
  assert.ok(!serialized.includes('waiverBudget'));
  assert.equal(lines[0]!.settings, REDACTED);
  assert.equal(lines[0]!.scoringSettings, REDACTED);
  // Stable, so two lines about one account can still be joined to each other.
  assert.equal(lines[0]!.login, identify('admin'));
  assert.equal(identify('admin'), identify('admin'));
  assert.notEqual(identify('admin'), identify('someone-else'));
});

test('the fields that make a log searchable survive redaction', () => {
  const { log, lines } = recorder();
  log.info({ route: '/api/dashboard/:leagueId', component: 'league-sync', status: 200, leagueId: '1234' }, 'request completed');
  // A route pattern looks exactly like a filesystem path to a blunt rule, and is the single most
  // useful field in an access log.
  assert.equal(lines[0]!.route, '/api/dashboard/:leagueId');
  assert.equal(lines[0]!.component, 'league-sync');
  assert.equal(lines[0]!.leagueId, '1234');
  // A UUID identifies a league or a session family. It is opaque, it is not a credential, and a log
  // that loses it cannot be joined to anything.
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.equal(redactString(uuid), uuid);
});

test('a level is a floor, and silent is a floor nothing clears', () => {
  const lines: string[] = [];
  const write = (_level: LogLevel, line: string) => lines.push(line);
  const quiet = createLogger({ level: 'warn', write }, {});
  quiet.debug({}, 'debug'); quiet.info({}, 'info'); quiet.warn({}, 'warn'); quiet.error({}, 'error');
  assert.equal(lines.length, 2);
  const silent = createLogger({ level: 'silent', write }, {});
  silent.error({}, 'error');
  assert.equal(lines.length, 2);
});

test('a child logger carries its bound fields onto every line', () => {
  const { log, lines } = recorder();
  log.child({ requestId: 'abc-123' }).info({ status: 200 }, 'done');
  assert.equal(lines[0]!.requestId, 'abc-123');
  assert.equal(lines[0]!.status, 200);
});

test('a value that cannot be serialized costs its fields, never the line', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (_level: LogLevel, line: string) => lines.push(line) }, {});
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  log.error({ circular }, 'still reported');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /still reported/);
});

test('redaction is bounded in depth, breadth and length, so one field cannot be the whole log', () => {
  const deep: Record<string, unknown> = { a: { b: { c: { d: { e: 'buried' } } } } };
  const shallow = redact(deep) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  assert.equal(shallow.a!.b!.c!.d, REDACTED);
  const wide = redact({ list: Array.from({ length: 50 }, (_, index) => index) }) as { list: unknown[] };
  assert.equal(wide.list.length, 21, 'twenty entries and a count of what was dropped');
  assert.ok(redactString('x'.repeat(2_000)).length < 600);
});
