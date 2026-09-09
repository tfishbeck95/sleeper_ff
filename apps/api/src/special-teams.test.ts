import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_SCORING, interpretScoring,
  type IndividualSpecialTeamsForecast, type NflPlayer, type ScoringConfiguration,
} from '@sleeper/domain';
import { analyzeLineup } from './lineup.js';
import { scoreLeagueForecasts, weekPoints } from './projection-scoring.js';
import {
  individualSpecialTeamsStats, normalizeSpecialTeamsStats, scaleSpecialTeams, specialTeamsCautions,
  validateIndividualSpecialTeams, withSpecialTeams,
} from './special-teams.js';
import { parseWaiverSignals, type PlayerSignal } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoLineupInput, demoWaiverInput } from './test-support/scoring-fixtures.js';

const now = new Date('2026-09-08T12:00:00Z');
const rules = (rates: Record<string, number> = {}, omit: string[] = []) => {
  const settings: Record<string, number> = { ...EXPECTED_SCORING, ...rates };
  for (const key of omit) delete settings[key];
  return interpretScoring([], { kind: 'complete-live', settings, rawSettings: {}, synchronizedAt: now.toISOString(), issues: [] } as ScoringConfiguration);
};
const near = (a: number, b: number, why = '') => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}${why ? `: ${why}` : ''}`);
/** A designated returner whose provider models every category this league scores. */
const covered = (over: Partial<IndividualSpecialTeamsForecast> = {}): IndividualSpecialTeamsForecast => ({
  touchdowns: .04, forcedFumbles: .1, fumbleRecoveries: .06,
  coverage: { touchdowns: true, forcedFumbles: true, fumbleRecoveries: true },
  returnRole: { kickReturns: 'primary', puntReturns: 'committee', expectedReturns: 3.5 },
  ...over,
});
const score = (forecast: IndividualSpecialTeamsForecast | undefined, stats: Record<string, number> = {}, rates: Record<string, number> = {}, omit: string[] = []) => {
  const r = rules(rates, omit);
  return withSpecialTeams(r, r.score(normalizeSpecialTeamsStats(r, stats, forecast, 'week 8')), forecast);
};

test('every modeled category scores once at this league’s own live rate', () => {
  const s = score(covered(), { rec: 5, rec_yd: 60 });
  const st = s.specialTeams!;
  assert.equal(st.entity, 'individual-player');
  assert.equal(st.coverage, 'complete');
  assert.deepEqual(st.uncovered, []);
  near(st.expectedPoints, .04 * 6 + .1 * 1 + .06 * 2);   // st_td 6, st_ff 1, st_fum_rec 2
  near(s.points, 5 + 6 + .24 + .1 + .12);
  assert.deepEqual(st.components.map(c => [c.stat, c.teamStat, c.amount, c.rate]), [
    ['st_td', 'def_st_td', .04, 6], ['st_ff', 'def_st_ff', .1, 1], ['st_fum_rec', 'def_st_fum_rec', .06, 2],
  ]);
  // The individual recovery rule is twice its team counterpart; neither is ever used for the other.
  assert.equal(st.components[2].rate, EXPECTED_SCORING.st_fum_rec);
  assert.notEqual(EXPECTED_SCORING.st_fum_rec, EXPECTED_SCORING.def_st_fum_rec);
  assert.equal(st.rankingAdjustment, 0);
  assert.deepEqual(st.uncertainty, []);
  assert.match(s.explanation, /every category this league pays for modeled/);
});

test('an unmodeled category is unknown, not zero, and no expected bonus is invented for it', () => {
  const partial = covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true } });
  const s = score(partial, { rec: 5 });
  const st = s.specialTeams!;
  assert.equal(st.coverage, 'partial');
  assert.deepEqual(st.uncovered, ['touchdowns']);
  const touchdowns = st.components[0];
  assert.equal(touchdowns.amount, null, 'an unmodeled count is null, never a zero that reads as a projection');
  assert.equal(touchdowns.modeled, false);
  assert.equal(touchdowns.points, 0);
  // 1. The league rule is read from the live snapshot rather than assumed to be zero.
  assert.equal(touchdowns.rate, 6);
  assert.equal(touchdowns.scored, true);
  // 2. Nothing is fabricated: the total is exactly the modeled categories, with no return-TD bonus.
  near(st.expectedPoints, .1 * 1 + .06 * 2);
  near(s.points, 5 + .1 + .12);
  assert.match(touchdowns.explanation, /Your league pays 6 per st_td/);
  assert.match(touchdowns.explanation, /instead of valuing it at zero/);
  assert.match(touchdowns.explanation, /no expected count is invented/);
  // 3. The projection is marked, and 4. a designated return role names why the gap matters.
  assert.match(s.explanation, /missing from the total. The missing scoring is unknown, not zero/);
  assert.ok(st.uncertainty.some(note => /designated/.test(note) || /return duty is part of this player/.test(note)));
  // Modeling none of it is `absent`, and still adds nothing.
  const none = score(covered({ touchdowns: undefined, forcedFumbles: undefined, fumbleRecoveries: undefined, coverage: { touchdowns: false, forcedFumbles: false, fumbleRecoveries: false } }), { rec: 5 });
  assert.equal(none.specialTeams!.coverage, 'absent');
  near(none.specialTeams!.expectedPoints, 0);
  near(none.points, 5);
  assert.equal(none.specialTeams!.uncovered.length, 3);
});

test('a rule this league does not define is unknown in either direction, never scored as zero', () => {
  const s = score(undefined, { rec: 5 }, {}, ['st_td']);
  const st = s.specialTeams!;
  assert.deepEqual(st.undefinedRules, ['touchdowns']);
  assert.equal(st.components[0].rate, null);
  assert.equal(st.components[0].scored, false);
  assert.match(st.components[0].explanation, /does not define st_td, so what it pays is unknown rather than zero/);
  assert.ok(st.uncertainty.some(note => /unknown rather than zero/.test(note)));
  // A rule configured and switched off is a different statement, and is reported as such.
  const off = score(undefined, { rec: 5 }, { st_td: 0, st_ff: 0, st_fum_rec: 0 });
  assert.equal(off.specialTeams!.coverage, 'not-scored');
  assert.deepEqual(off.specialTeams!.uncovered, []);
  assert.match(off.specialTeams!.components[0].explanation, /scores st_td at 0, so modeling it would change nothing/);
  assert.equal(off.explanation, off.explanation.replace(/Special teams:.*/, off.explanation.includes('Special teams:') ? 'x' : ''));
});

test('the coverage declaration and the counts must agree, in both directions', () => {
  assert.throws(() => validateIndividualSpecialTeams({ coverage: { touchdowns: true, forcedFumbles: true, fumbleRecoveries: true } }), /declared modeled, so it requires a finite nonnegative expected count/);
  assert.throws(() => validateIndividualSpecialTeams({ touchdowns: .04, coverage: { touchdowns: false, forcedFumbles: false, fumbleRecoveries: false } }), /supplies a count while declaring the category unmodeled/);
  assert.throws(() => validateIndividualSpecialTeams(covered({ coverage: { touchdowns: true, forcedFumbles: true, fumbleRecoveries: undefined } as never })), /must be true or false/);
  assert.throws(() => validateIndividualSpecialTeams(covered({ touchdowns: 4 })), /at most 0.5/);
  assert.throws(() => validateIndividualSpecialTeams({ ...covered(), returns: 3 } as unknown), /unknown field/);
  assert.throws(() => validateIndividualSpecialTeams(covered({ returnRole: { kickReturns: 'starter', puntReturns: 'none' } as never })), /kickReturns must be one of/);
  assert.throws(() => validateIndividualSpecialTeams(covered({ returnRole: { kickReturns: 'none', puntReturns: 'none', expectedReturns: 3 } })), /contradict a return role with no kick-return and no punt-return duty/);
  // An explicit zero from a provider that models the category is a projection, and is accepted.
  const zero = score(covered({ touchdowns: 0 }), {});
  assert.equal(zero.specialTeams!.coverage, 'complete');
  assert.equal(zero.specialTeams!.components[0].amount, 0);
  assert.equal(zero.specialTeams!.components[0].modeled, true);
});

test('one entity never carries both special-teams families, and never counts one event twice', () => {
  const r = rules();
  // The team rules belong to the D/ST entity and are refused on a rostered player's line.
  assert.throws(() => normalizeSpecialTeamsStats(r, { def_st_td: 1 }, covered(), 'week 8'), /belongs to the D\/ST entity/);
  assert.throws(() => normalizeSpecialTeamsStats(r, { def_st_fum_rec: 1 }, undefined, 'week 8'), /the two families pay different rates and are never combined on one entity/);
  // A raw individual key requires the declaring forecast, so a count is never mistaken for a gap.
  assert.throws(() => normalizeSpecialTeamsStats(r, { st_td: .04 }, undefined, 'week 8'), /without an individual special-teams forecast/);
  assert.throws(() => normalizeSpecialTeamsStats(r, { st_td: .04 }, covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true } }), 'week 8'), /declares that category unmodeled/);
  assert.throws(() => normalizeSpecialTeamsStats(r, { st_td: .09 }, covered(), 'week 8'), /conflicts with its individual special-teams forecast/);
  // Overlapping counts that agree are written once, so the same return touchdown scores once.
  const both = score(covered(), { st_td: .04, st_ff: .1, st_fum_rec: .06 });
  const single = score(covered(), {});
  near(both.points, single.points);
  near(both.points, .04 * 6 + .1 + .06 * 2);
  assert.equal(both.contributions.filter(c => c.stat === 'st_td').length, 1);
  assert.deepEqual(individualSpecialTeamsStats(covered()), { st_td: .04, st_ff: .1, st_fum_rec: .06 });
  // A category the provider does not model writes no key at all, rather than a zero.
  assert.deepEqual(individualSpecialTeamsStats(covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true } })), { st_ff: .1, st_fum_rec: .06 });
  // A rule this league does not define is not forced into the generic raw-stat boundary.
  assert.equal(Object.hasOwn(normalizeSpecialTeamsStats(rules({}, ['st_td']), {}, covered(), 'week 8'), 'st_td'), false);
});

test('other individual special-teams rules on the same line are reported, never lost', () => {
  const s = score(covered(), { st_tkl_solo: 2 }, { st_tkl_solo: .5 });
  near(s.specialTeams!.otherPoints, 1);
  near(s.points, .04 * 6 + .1 + .06 * 2 + 1);
  assert.match(s.explanation, /other individual special-teams rules on the same stat line/);
});

const player = (id: string, position: string): NflPlayer => ({
  id, fullName: `Test ${id}`, firstName: null, lastName: null, team: 'SAMPLE', position,
  fantasyPositions: [position], status: 'Active', injuryStatus: null, sourceUpdatedAt: null, synchronizedAt: now.toISOString(),
});
const signals = (players: PlayerSignal[]) => ({ season: '2026', week: 8, source: 'test', updatedAt: now.toISOString(), players });
const boundary = (signal: PlayerSignal, position = 'WR') => scoreLeagueForecasts({
  rules: rules(), signals: signals([signal]), players: [player(signal.playerId, position)],
  requiredWeeks: [8], availability: { policy: 'selected-week', selectedWeek: 8 }, scoredAt: now,
});

test('the scoring boundary attributes each family to its intended fantasy entity', () => {
  const week = { week: 8, bye: false, stats: { rec: 5 } };
  // A rostered player carrying a team defense contract is refused, not silently ignored.
  const misplacedTeam = boundary({ playerId: 'wr', weeks: [{ ...week, defense: { sacks: 1, interceptions: 0, forcedFumbles: 0, fumbleRecoveries: 0, safeties: 0, blockedKicks: 0, defensiveTouchdowns: 0, pointsAllowed: { buckets: { '0': 0, '1_6': 0, '7_13': 1, '14_20': 0, '21_27': 0, '28_34': 0, '35p': 0 } }, yardsAllowed: { buckets: { '0_100': 0, '100_199': 0, '200_299': 1, '300_349': 0, '350_399': 0, '400_449': 0, '450_499': 0, '500_549': 0, '550p': 0 } } } }] });
  assert.equal(misplacedTeam.players.length, 0);
  assert.equal(misplacedTeam.rejected[0].kind, 'identity');
  assert.match(misplacedTeam.rejected[0].message, /carries a team defense forecast/);
  // A team unit carrying an individual return contract is refused for the mirror-image reason.
  const misplacedIndividual = boundary({ playerId: 'def', weeks: [{ ...week, stats: {}, specialTeams: covered() }] }, 'DEF');
  assert.equal(misplacedIndividual.rejected[0].kind, 'identity');
  assert.match(misplacedIndividual.rejected[0].message, /carries an individual special-teams forecast/);
  assert.match(misplacedIndividual.rejected[0].message, /def_st_td, def_st_ff, def_st_fum_rec/);
  // Team keys inside a player's raw stat line are refused as a units problem.
  const teamKeys = boundary({ playerId: 'wr', weeks: [{ ...week, stats: { rec: 5, def_st_td: .05 } }] });
  assert.equal(teamKeys.rejected[0].kind, 'identity');
  assert.match(teamKeys.rejected[0].message, /belongs to the D\/ST entity/);
  assert.match(teamKeys.rejected[0].message, /pay different rates for the same real event/);
  const individualKeys = boundary({ playerId: 'def', weeks: [{ ...week, stats: { st_td: .05 } }] }, 'DEF');
  assert.equal(individualKeys.rejected[0].kind, 'identity');
  assert.match(individualKeys.rejected[0].message, /a rostered returner scores on their own line/);
});

test('coverage and scoring survive every scenario, adjustment and horizon the boundary applies', () => {
  const scored = boundary({ playerId: 'wr',
    weeks: [{ week: 8, bye: false, stats: { rec: 5 }, specialTeams: covered(),
      floorStats: { rec: 3 }, floorSpecialTeams: covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true } }),
      ceilingStats: { rec: 9 }, ceilingSpecialTeams: covered({ touchdowns: .08 }) }],
    dynastyStats: { rec: 6 }, dynastySpecialTeams: covered() });
  const week = scored.players[0].weeks[0];
  assert.equal(week.mean.specialTeams!.coverage, 'complete');
  assert.equal(week.floor!.specialTeams!.coverage, 'partial', 'each scenario carries its own coverage');
  near(week.ceiling!.specialTeams!.expectedPoints, .08 * 6 + .1 + .12);
  assert.equal(scored.players[0].dynasty!.specialTeams!.coverage, 'complete');
  // Floor and ceiling remain ordered around the mean once return scoring is included.
  assert.ok(week.floor!.points < week.mean.points && week.mean.points < week.ceiling!.points);
  assert.equal(scored.rejected.length, 0);
  // A scenario forecast without its raw stat line is refused rather than scored against the mean.
  const orphan = boundary({ playerId: 'wr', weeks: [{ week: 8, bye: false, stats: { rec: 5 }, ceilingSpecialTeams: covered() }] });
  assert.equal(orphan.rejected[0].kind, 'units');
  assert.match(orphan.rejected[0].message, /scenario metadata requires its raw stat line/);
});

test('availability zeroes the points while the coverage facts stay readable', () => {
  const scored = boundary({ playerId: 'wr', injuryStatus: 'Out', weeks: [{ week: 8, bye: false, stats: { rec: 5 }, specialTeams: covered() }] });
  const week = scored.players[0].weeks[0];
  const adjusted = weekPoints(rules(), week);
  near(adjusted.points, 0);
  near(adjusted.specialTeams!.expectedPoints, 0);
  assert.equal(adjusted.specialTeams!.coverage, 'complete');
  assert.match(adjusted.specialTeams!.availabilityNote!, /before availability/);
  // A role adjustment scales the modeled points and leaves coverage and role untouched.
  const scaled = scaleSpecialTeams(week.mean.specialTeams!, 1.1);
  near(scaled.expectedPoints, Math.round(week.mean.specialTeams!.expectedPoints * 1.1 * 100) / 100);
  assert.deepEqual(scaled.returnRole, week.mean.specialTeams!.returnRole);
  assert.deepEqual(scaled.uncovered, week.mean.specialTeams!.uncovered);
});

test('a comparison names the missing return scoring only where a return role makes it concrete', () => {
  const designated = score(covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true } }), { rec: 4 });
  const anonymous = score(undefined, { rec: 9 });
  const cautions = specialTeamsCautions({ name: 'Higher', scored: anonymous }, { name: 'Lower', scored: designated }, 5);
  assert.equal(cautions.length, 1);
  assert.match(cautions[0], /Lower has a designated return role \(primary kick returns, committee punt returns on 3.5 expected returns per game\)/);
  assert.match(cautions[0], /does not model st_td/);
  assert.match(cautions[0], /a return touchdown nobody projected is not a reason to start the lower-scoring player/);
  // Without a declared role the gap is unknowable, so it is disclosed once at report level instead.
  assert.deepEqual(specialTeamsCautions({ name: 'Higher', scored: score(undefined, { rec: 9 }) }, { name: 'Lower', scored: anonymous }, 5), []);
  // A player designated as having no return duty is never flagged.
  const none = score(covered({ touchdowns: undefined, coverage: { touchdowns: false, forcedFumbles: true, fumbleRecoveries: true }, returnRole: { kickReturns: 'none', puntReturns: 'none' } }), { rec: 4 });
  assert.deepEqual(specialTeamsCautions({ name: 'Higher', scored: anonymous }, { name: 'Lower', scored: none }, 5), []);
  assert.equal(none.specialTeams!.relevance, 'not-relevant');
});

test('lineup analysis discloses incomplete coverage without letting return upside change a ranking', () => {
  const input = demoLineupInput(now);
  const report = analyzeLineup(input);
  assert.equal(report.status !== 'unavailable', true);
  const warning = report.warnings.find(w => w.includes('incomplete individual special-teams coverage'));
  assert.ok(warning, 'a league that scores st_* with a forecast that models none of it says so once');
  assert.match(warning!, /st_td, st_ff, st_fum_rec/);
  assert.match(warning!, /rather than valuing it at zero/);
  assert.match(warning!, /no return-touchdown upside is added to any total or ranking/);
  // Every rostered projection is marked, and none of them gained points from the unmodeled rules.
  for (const slot of report.lineup) {
    if (!slot.player) continue;
    const st = slot.player.scored.specialTeams!;
    assert.equal(st.coverage, 'absent');
    assert.equal(st.expectedPoints, 0);
    assert.equal(st.rankingAdjustment, 0);
    assert.deepEqual(st.uncovered, ['touchdowns', 'forcedFumbles', 'fumbleRecoveries']);
  }
  // With nothing modeled anywhere, no start/sit decision invents a return-based caution.
  assert.equal(report.startSit.some(d => d.cautions.some(c => /designated return role/.test(c))), false);
});

test('a lower-scoring return specialist is never promoted on unmodeled return upside', () => {
  const input = demoWaiverInput(now);
  // `add-te` projects below `add-wr`. Declaring a full-time return role changes nothing it earns.
  for (const signal of input.signals!.players) {
    if (signal.playerId !== 'add-te') continue;
    signal.weeks = signal.weeks.map(week => ({ ...week, specialTeams: { coverage: { touchdowns: false, forcedFumbles: false, fumbleRecoveries: false }, returnRole: { kickReturns: 'primary', puntReturns: 'primary', expectedReturns: 6 } } }));
  }
  const withRole = recommendWaivers(input);
  const baseline = recommendWaivers(demoWaiverInput(now));
  const priority = (report: typeof withRole, id: string) => report.recommendations.filter(r => r.add.id === id).map(r => `${r.horizon}:${r.score}`);
  assert.deepEqual(priority(withRole, 'add-te'), priority(baseline, 'add-te'), 'a designated return role adds no priority score');
  assert.deepEqual(withRole.recommendations.map(r => r.id), baseline.recommendations.map(r => r.id), 'the ranking order is unchanged');
  const streamer = withRole.recommendations.find(r => r.add.id === 'add-te' && r.horizon === 'streamer');
  if (streamer) {
    assert.equal(streamer.specialTeams!.rankingAdjustment, 0);
    assert.ok(streamer.uncertainty.some(note => /Incomplete special-teams coverage/.test(note)), 'the gap is disclosed as uncertainty, never as upside');
    assert.ok(streamer.reasons.some(reason => /Return upside contributes 0 to this priority score/.test(reason)));
  }
  assert.ok(withRole.warnings.some(w => /incomplete individual special-teams coverage/.test(w)));
});

test('the adapter validates the individual contract before any of it reaches scoring', () => {
  const base = { season: '2026', week: 8, source: 'test', updatedAt: now.toISOString() };
  const build = (weeks: unknown[], extra: Record<string, unknown> = {}) => ({ ...base, players: [{ playerId: 'wr', weeks, ...extra }] });
  assert.throws(() => parseWaiverSignals(build([{ week: 8, stats: { rec: 5 }, specialTeams: { coverage: { touchdowns: true, forcedFumbles: true, fumbleRecoveries: true } } }])), /declared modeled/);
  assert.throws(() => parseWaiverSignals(build([{ week: 8, ceilingSpecialTeams: covered(), stats: { rec: 5 } }])), /requires its raw stat scenario/);
  assert.throws(() => parseWaiverSignals(build([{ week: 8, stats: { rec: 5 } }], { dynastySpecialTeams: covered() })), /requires dynastyStats/);
  // A stat line that carries nothing but return counts is a complete scenario, not an empty one.
  const accepted = parseWaiverSignals(build([{ week: 8, bye: false, stats: {}, specialTeams: covered() }]));
  assert.equal(accepted.players[0].weeks[0].specialTeams!.coverage.touchdowns, true);
});
