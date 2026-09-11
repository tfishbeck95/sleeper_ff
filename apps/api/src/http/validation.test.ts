import test from 'node:test';
import assert from 'node:assert/strict';
import { fields, integer, list, optional, param, pattern, playerSelection, query, suppliedBounds, tradeBoundFields, ValidationError, withDefault } from './validation.js';

/** A request, reduced to the two things a schema reads. */
const asRequest = (queryString: Record<string, unknown>, params: Record<string, string> = {}) => ({ query: queryString, params } as never);
const refusal = (run: () => unknown): ValidationError => {
  try { run(); } catch (error) { assert.ok(error instanceof ValidationError, `expected a ValidationError, got ${String(error)}`); return error; }
  throw new Error('expected the schema to refuse this');
};

test('a query parameter the route does not read is refused rather than ignored', () => {
  const error = refusal(() => query(asRequest({ week: '8', rosterId: '2' }), { week: fields.week }));
  assert.equal(error.status, 400);
  assert.equal(error.parameter, 'rosterId');
  assert.match(error.message, /not a recognized query parameter/);
});

test('a parameter supplied twice is refused rather than one of the two being picked', () => {
  // Express turns `?week=8&week=9` into an array, and the two readings can authorize differently.
  const error = refusal(() => query(asRequest({ week: ['8', '9'] }), { week: fields.week }));
  assert.match(error.message, /more than once/);
});

test('nothing is coerced into being valid', () => {
  const parse = (week: string) => query(asRequest({ week }), { week: fields.week }).week;
  assert.equal(parse('8'), 8);
  // Every one of these is a number as far as `Number()` is concerned, and none of them is a week.
  for (const hostile of ['', ' 8', '8 ', '8.0', '1.5', '0x8', '8e0', '+8', '0', '19', '-1', '8abc', 'NaN', 'Infinity']) {
    refusal(() => parse(hostile));
  }
});

test('absent and present-but-empty are different requests', () => {
  // Absent may fall back to a default...
  assert.equal(query(asRequest({}), { limit: withDefault(fields.resultLimit, 25) }).limit, 25);
  assert.equal(query(asRequest({}), { week: optional(fields.week) }).week, undefined);
  // ...present and empty may not: a caller who built a list and got nothing into it made a mistake,
  // and answering with the whole roster instead would be answering a question they did not ask.
  refusal(() => query(asRequest({ ids: '' }), { ids: optional(fields.playerIds) }));
  refusal(() => query(asRequest({ limit: '' }), { limit: withDefault(fields.resultLimit, 25) }));
  // A required parameter says it is required rather than that it has the wrong shape.
  assert.match(refusal(() => query(asRequest({}), { week: fields.week })).message, /is required/);
});

test('a refusal names the parameter and the shape, and never repeats the value', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const error = refusal(() => query(asRequest({ week: hostile }), { week: fields.week }));
  assert.ok(!error.message.includes(hostile), 'a response that echoes a request can be aimed at somebody else');
  assert.equal(error.message, "'week' must be a whole number from 1 to 18.");
});

test('identifiers are bounded to an alphabet that cannot traverse a path or open a query', () => {
  assert.equal(param(asRequest({}, { leagueId: '1234' }), 'leagueId', fields.leagueId), '1234');
  assert.equal(param(asRequest({}, { leagueId: 'demo' }), 'leagueId', fields.leagueId), 'demo');
  for (const hostile of ['../../etc/passwd', '1234/rosters', '1234?x=1', '1234%2f', 'a'.repeat(33), '', 'a b', '1234#frag', 'https://elsewhere.test']) {
    refusal(() => param(asRequest({}, { leagueId: hostile }), 'leagueId', fields.leagueId));
  }
  for (const hostile of ['bad name', 'name/../..', 'a'.repeat(65)]) {
    refusal(() => param(asRequest({}, { username: hostile }), 'username', fields.sleeperUsername));
  }
});

test('a list is bounded in length and in what each entry may be', () => {
  const ids = list(pattern(/^[a-z0-9]+$/, 8, 'ids'), 3, 'up to three ids');
  assert.deepEqual(query(asRequest({ ids: 'a,b,c' }), { ids }).ids, ['a', 'b', 'c']);
  refusal(() => query(asRequest({ ids: 'a,b,c,d' }), { ids }));
  // An empty entry is a mistake, not an entry.
  refusal(() => query(asRequest({ ids: 'a,,c' }), { ids }));
  refusal(() => query(asRequest({ ids: 'a,B!,c' }), { ids }));
});

test('the player selection is ids or a search, never both and never a way to dump the directory', () => {
  assert.deepEqual(playerSelection(asRequest({ ids: 'p1,p2' })), { ids: ['p1', 'p2'] });
  assert.deepEqual(playerSelection(asRequest({ q: 'mahomes' })), { query: 'mahomes', limit: 25 });
  assert.deepEqual(playerSelection(asRequest({ q: 'mahomes', limit: '5' })), { query: 'mahomes', limit: 5 });
  // Neither is not an error — the route falls back to the league's own rosters — but both is.
  assert.equal(playerSelection(asRequest({})), null);
  assert.match(refusal(() => playerSelection(asRequest({ ids: 'p1', q: 'mahomes' }))).message, /not both/);
  refusal(() => playerSelection(asRequest({ q: 'a' })));
  refusal(() => playerSelection(asRequest({ q: 'mahomes', limit: '51' })));
  refusal(() => playerSelection(asRequest({ ids: Array(101).fill('p1').join(',') })));
  // A player id the directory itself would refuse is a bad request, not an empty result.
  refusal(() => playerSelection(asRequest({ ids: '0' })));
});

test('trade bounds are ranged by the schema and handed on only where they were supplied', () => {
  const parsed = query(asRequest({ maxRisk: '0.5', maxResults: '8' }), tradeBoundFields);
  assert.deepEqual(suppliedBounds(parsed), { maxRisk: 0.5, maxResults: 8 });
  // What is absent stays absent, so `parseTradeBounds` applies its own defaults rather than ours.
  assert.deepEqual(suppliedBounds(query(asRequest({}), tradeBoundFields)), {});
  for (const hostile of [{ maxRisk: 'NaN' }, { maxRisk: '-1' }, { maxRisk: '1.5' }, { maxResults: '999' }, { maxResults: '2.5' }, { maxValueGap: 'Infinity' }]) {
    refusal(() => query(asRequest(hostile), tradeBoundFields));
  }
});

test('a rule composes without losing its bounds', () => {
  const ranged = optional(integer(1, 3));
  assert.equal(query(asRequest({ n: '2' }), { n: ranged }).n, 2);
  assert.equal(query(asRequest({}), { n: ranged }).n, undefined);
  refusal(() => query(asRequest({ n: '4' }), { n: ranged }));
});
