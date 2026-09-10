import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, interpretScoring, liveScoring } from '@sleeper/domain';
import { assessCoverage, DEFENSE_IMPLIED_KEYS, familiesFor, individualSpecialTeamsKeys, KICKER_IMPLIED_KEYS } from './coverage.js';

const rules = (overrides: Record<string, number> = {}) => {
  const settings = { ...EXPECTED_SCORING, ...overrides };
  return interpretScoring(settings, liveScoring(settings, '2026-09-10T12:00:00.000Z'));
};
const OFFENSE = ['pass_yd', 'pass_td', 'pass_int', 'pass_2pt', 'rush_yd', 'rush_td', 'rush_2pt', 'rec', 'rec_yd', 'rec_td', 'rec_2pt', 'fum_lost', 'fum_rec_td'];

test('a feed supplying every scored rule reports complete coverage', () => {
  const report = assessCoverage(rules(), {
    QB: OFFENSE, RB: [...OFFENSE, ...individualSpecialTeamsKeys({ touchdowns: true, forcedFumbles: true, fumbleRecoveries: true })],
    WR: [...OFFENSE, 'st_td', 'st_ff', 'st_fum_rec'], TE: [...OFFENSE, 'st_td', 'st_ff', 'st_fum_rec'],
    K: KICKER_IMPLIED_KEYS, DEF: [...DEFENSE_IMPLIED_KEYS, 'def_st_td', 'def_st_ff', 'def_st_fum_rec'],
  });
  assert.equal(report.complete, true, report.summary);
  assert.equal(report.uncovered.length, 0);
  assert.match(report.summary, /Every one of the \d+ rules/);
});

test('a scored rule the feed omits is recorded, named, and never assumed to be zero', () => {
  const report = assessCoverage(rules(), { QB: OFFENSE, RB: OFFENSE, WR: OFFENSE, TE: OFFENSE, K: KICKER_IMPLIED_KEYS, DEF: DEFENSE_IMPLIED_KEYS });
  assert.equal(report.complete, false);
  // The individual and team return families are both missing, and both are named separately.
  for (const stat of ['st_td', 'st_ff', 'st_fum_rec', 'def_st_td', 'def_st_ff', 'def_st_fum_rec']) {
    assert.ok(report.uncovered.includes(stat), `${stat} reported as uncovered`);
  }
  assert.match(report.summary, /are not supplied/);
});

test('a rule this league sets to zero creates no coverage obligation', () => {
  const complete = assessCoverage(rules({ st_td: 0, st_ff: 0, st_fum_rec: 0, def_st_td: 0, def_st_ff: 0, def_st_fum_rec: 0 }), {
    QB: OFFENSE, RB: OFFENSE, WR: OFFENSE, TE: OFFENSE, K: KICKER_IMPLIED_KEYS, DEF: DEFENSE_IMPLIED_KEYS,
  });
  assert.equal(complete.complete, true, complete.summary);
});

test('a derived category is reported as covered and separately flagged as derived', () => {
  const report = assessCoverage(rules(), { K: KICKER_IMPLIED_KEYS }, ['fgm_50_59', 'fgm_60p']);
  const kicker = report.families.find(family => family.family === 'K')!;
  assert.ok(kicker.covered.includes('fgm_50_59'));
  assert.deepEqual(kicker.derived.sort(), ['fgm_50_59', 'fgm_60p']);
});

test('a scored rule no supported position family produces is reported as unsupported, not as a gap', () => {
  const report = assessCoverage(rules({ idp_tkl_solo: 1 }), {});
  assert.ok(report.unsupported.includes('idp_tkl_solo'));
  assert.match(report.summary, /no supported position family/);
});

test('rules map to the position families that could produce them', () => {
  assert.deepEqual(familiesFor('pass_yd'), ['QB']);
  assert.deepEqual(familiesFor('rec'), ['RB', 'WR', 'TE']);
  assert.deepEqual(familiesFor('fgm_50_59'), ['K']);
  assert.deepEqual(familiesFor('pts_allow_0'), ['DEF']);
  assert.deepEqual(familiesFor('def_st_td'), ['DEF']);
  assert.deepEqual(familiesFor('st_td'), ['RB', 'WR', 'TE']);
  // `int` is the defence's interception; the quarterback's is `pass_int`, and they never merge.
  assert.deepEqual(familiesFor('int'), ['DEF']);
  assert.deepEqual(familiesFor('pass_int'), ['QB']);
  assert.deepEqual(familiesFor('some_future_rule'), []);
});

test('only the special-teams categories a provider declares count as supplied', () => {
  assert.deepEqual(individualSpecialTeamsKeys({ touchdowns: true, forcedFumbles: false, fumbleRecoveries: false }), ['st_td']);
  const report = assessCoverage(rules(), { WR: ['rec', 'rec_yd', 'rec_td', 'st_td'] });
  const receivers = report.families.find(family => family.family === 'WR')!;
  assert.ok(receivers.uncovered.includes('st_ff'));
  assert.ok(receivers.uncovered.includes('st_fum_rec'));
  assert.ok(!receivers.uncovered.includes('st_td'));
});
