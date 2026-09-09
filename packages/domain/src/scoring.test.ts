import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EXPECTED_SCORING, liveScoring, referenceScoring, scoringUnavailable, interpretScoring, scoringFormatLabel, scoringSummary } from './index.js';
const at = '2026-09-08T12:00:00Z';

test('expected key mapping covers every documented screenshot value without loading text at runtime', async () => {
  const text = await readFile(new URL('../../../docs/league-scoring-rules.txt', import.meta.url), 'utf8');
  const pairs = [...text.matchAll(/\[Sleeper: (\w+) = (-?[\d.]+)\]/g)].map(m => [m[1], Number(m[2])] as const);
  assert.equal(pairs.length, text.split('\n').filter(line => line.startsWith('- ')).length);
  assert.equal(new Set(pairs.map(p => p[0])).size, pairs.length);
  assert.deepEqual(Object.fromEntries(pairs), EXPECTED_SCORING);
  assert.equal(EXPECTED_SCORING.def_st_fum_rec, 1);
  assert.equal(EXPECTED_SCORING.st_fum_rec, 2);
});
test('complete live settings retain and score every additional rule including zero and negative values', () => {
  const raw = { ...EXPECTED_SCORING, bonus_rec_te: .5, pts_allow_35p: -4, future_rule: 0 };
  const scoring = liveScoring(raw, at);
  assert.equal(scoring.kind, 'complete-live'); assert.deepEqual(scoring.rawSettings, raw);
  assert.deepEqual(scoring.settings, raw); assert.equal(scoring.synchronizedAt, at);
  assert.deepEqual(scoring.issues.map(i => i.key), ['bonus_rec_te', 'pts_allow_35p', 'future_rule']);
  const rules = interpretScoring([], scoring);
  assert.equal(rules.score({ rec: 5, bonus_rec_te: 5, pts_allow_35p: 1 }).points, 3.5);
  assert.match(scoringSummary(scoring), /PPR.*Pass TD 4.*40 rules/);
});
test('missing and mismatched documented values are reported explicitly, never filled or coerced', () => {
  const raw: Record<string, unknown> = { ...EXPECTED_SCORING, rec: .5, pass_td: '4' }; delete raw.fum_lost;
  const scoring = liveScoring(raw, at);
  assert.equal(scoring.kind, 'unavailable'); assert.equal(scoring.settings, null);
  assert.deepEqual(scoring.rawSettings, raw);
  assert.ok(scoring.issues.some(i => i.kind === 'missing' && i.key === 'fum_lost' && i.expected === -2));
  assert.ok(scoring.issues.some(i => i.kind === 'mismatched' && i.key === 'rec' && i.actual === .5));
  assert.ok(scoring.issues.some(i => i.kind === 'invalid' && i.key === 'pass_td'));
  for (const raw of [undefined, null, [], {}, 'PPR', { ...EXPECTED_SCORING, extra: Infinity }, { ...EXPECTED_SCORING, extra: NaN }]) assert.equal(liveScoring(raw, at).kind, 'unavailable');
  assert.equal(liveScoring(EXPECTED_SCORING, 'invalid').kind, 'unavailable');
});
test('partial, unavailable and legacy scoring cannot score statistics at all', () => {
  for (const config of [referenceScoring(), scoringUnavailable(), liveScoring({ rec: 1 }, at)]) {
    const rules = interpretScoring([], config);
    assert.equal(rules.actionable, false);
    assert.throws(() => rules.score({ rec: 5 }), /complete live/);
  }
  assert.equal(interpretScoring({ rec: 1 }).configuration.kind, 'partial-reference');
  assert.equal(interpretScoring({}).receptionFormat, 'unknown');
  assert.equal(scoringFormatLabel(scoringUnavailable()), 'unscored');
  assert.equal(scoringFormatLabel(liveScoring({ ...EXPECTED_SCORING }, at)), 'full-PPR');
  assert.equal(scoringFormatLabel(referenceScoring({ rec: .5 })), 'half-PPR');
  assert.equal(scoringFormatLabel(referenceScoring({ rec: 0 })), 'non-PPR');
  assert.equal(scoringFormatLabel(referenceScoring({ rec: .25 })), '0.25-point-reception');
  assert.equal(scoringFormatLabel(referenceScoring({})), 'custom');
});
