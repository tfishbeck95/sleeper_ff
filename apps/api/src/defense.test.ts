import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_SCORING, POINTS_ALLOWED_BUCKETS as PTS, YARDS_ALLOWED_BUCKETS as YDS,
  interpretScoring, type DefenseForecast, type ScoringConfiguration,
} from '@sleeper/domain';
import { defenseStats, defenseStreamerProfile, normalizeDefenseStats, scoreDefense, validateDefenseForecast } from './defense.js';
import { scoreLeagueForecasts, weekPoints } from './projection-scoring.js';
import { parseWaiverSignals } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './test-support/scoring-fixtures.js';

const now = new Date('2026-09-08T12:00:00Z');
const rules = (rates: Record<string, number> = {}, omit: string[] = []) => {
  const settings: Record<string, number> = { ...EXPECTED_SCORING, ...rates };
  for (const key of omit) delete settings[key];
  return interpretScoring([], { kind: 'complete-live', settings, rawSettings: {}, synchronizedAt: now.toISOString(), issues: [] } as ScoringConfiguration);
};
/** Every context term sits exactly on its neutral point, so each factor's direction is unambiguous. */
const forecast = (): DefenseForecast => ({
  sacks: 2.5, interceptions: .8, forcedFumbles: .9, fumbleRecoveries: .6,
  safeties: .05, blockedKicks: .1, defensiveTouchdowns: .25,
  pointsAllowed: { buckets: { '0': .06, '1_6': .12, '7_13': .24, '14_20': .28, '21_27': .18, '28_34': .08, '35p': .04 } },
  yardsAllowed: { buckets: { '0_100': .04, '100_199': .1, '200_299': .26, '300_349': .2, '350_399': .18, '400_449': .12, '450_499': .06, '500_549': .03, '550p': .01 } },
  specialTeams: { touchdowns: .05, forcedFumbles: .15, fumbleRecoveries: .1 },
  context: {
    includedInForecast: false,
    opponentPressure: { sackRateAllowed: .065, pressureRateAllowed: .22 },
    opponentTurnovers: { interceptionRate: .024, fumbleRate: .013 },
    opponentOffensiveLine: { startersOut: 0, continuity: .85 },
    opponentQuarterback: { status: 'confirmed-starter', name: 'Test starter' },
    specialTeams: { returnOpportunities: 4, opponentReturnYardsAllowed: 9 },
  },
});
const score = (f = forecast(), rates: Record<string, number> = {}, stats: Record<string, number> = {}, omit: string[] = []) => {
  const r = rules(rates, omit);
  return scoreDefense(r, normalizeDefenseStats(r, stats, f), f);
};
const near = (a: number, b: number, why = '') => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}${why ? `: ${why}` : ''}`);
const only = <T extends Record<string, number>>(buckets: readonly string[], winner: string) =>
  Object.fromEntries(buckets.map(b => [b, b === winner ? 1 : 0])) as T;

test('every required raw category scores once from the live map, with exhaustive group subtotals', () => {
  const s = score();
  near(s.points, 8.55);
  const d = s.defense!;
  near(d.pressurePoints, 2.5);          // 2.5 sacks × 1
  near(d.turnoverPoints, 3.1);          // .8 int × 2, .9 ff × 1, .6 fum_rec × 1
  near(d.touchdownPoints, 1.5);         // .25 def_td × 6
  near(d.situationalPoints, .3);        // .05 safe × 2, .1 blk_kick × 2
  near(d.specialTeamsPoints, .55);      // .05 def_st_td × 6, .15 def_st_ff × 1, .1 def_st_fum_rec × 1
  near(d.thresholdPoints, .6);          // .06 shutout × 8, .04 sub-100 × 3
  near(d.otherPoints, 0);
  // Any further rule the league scores on a supplied stat lands in `other`, so nothing is lost.
  const custom = score(forecast(), { def_forced_punts: .5 }, { def_forced_punts: 4 });
  near(custom.defense!.otherPoints, 2);
  near(custom.points, 10.55);
  near(d.pressurePoints + d.turnoverPoints + d.touchdownPoints + d.situationalPoints + d.specialTeamsPoints + d.thresholdPoints + d.otherPoints, s.points);
  assert.deepEqual(d.drivers.slice(0, 3).map(v => v.label), ['Sacks', 'Interceptions', 'Defensive touchdowns']);
  assert.match(d.explanation, /largest drivers Sacks \+2\.5, Interceptions \+1\.6, Defensive touchdowns \+1\.5/);
  // Each category answers to its own live rate, so a commissioner's change moves only its component.
  near(score(forecast(), { sack: 2, int: 3, safe: 5 }).points, 12);
});

test('forced fumbles and fumble recoveries stay separate scoring events in both phases', () => {
  const f = forecast();
  const base = score(f);
  assert.equal(defenseStats(f).ff, .9);
  assert.equal(defenseStats(f).fum_rec, .6);
  const contributions = new Map(base.contributions.map(c => [c.stat, c]));
  assert.equal(contributions.get('ff')!.amount, .9);
  assert.equal(contributions.get('fum_rec')!.amount, .6);
  assert.ok(contributions.has('def_st_ff') && contributions.has('def_st_fum_rec'));
  // A fumble this defense forces and recovers is two Sleeper events, and both are paid.
  const both = structuredClone(f); both.forcedFumbles = 1; both.fumbleRecoveries = 1;
  near(score(both).points - base.points, .1 * 1 + .4 * 1);
  // Neither count is derived from the other: recovering more than you force is legal (aborted snaps),
  // and forcing without recovering is legal (the offense falls on it).
  const recoveredOnly = structuredClone(f); recoveredOnly.forcedFumbles = 0; recoveredOnly.fumbleRecoveries = 2;
  validateDefenseForecast(recoveredOnly);
  near(score(recoveredOnly).points, base.points - .9 + 1.4);
  const forcedOnly = structuredClone(f); forcedOnly.forcedFumbles = 2; forcedOnly.fumbleRecoveries = 0;
  validateDefenseForecast(forcedOnly);
  near(score(forcedOnly).points, base.points + 1.1 - .6);
  // Distinct live rates never collapse: only the recovery rule moves when only it changes.
  near(score(f, { fum_rec: 3 }).points - base.points, .6 * 2);
  near(score(f, { ff: 4 }).points - base.points, .9 * 3);
  near(score(f, { def_st_ff: 5 }).points - base.points, .15 * 4);
  near(score(f, { def_st_fum_rec: 7 }).points - base.points, .1 * 6);
});

test('defensive and special-teams touchdowns map to their own Sleeper fields, never the individual rules', () => {
  const f = forecast();
  const stats = defenseStats(f);
  assert.equal(stats.def_td, .25);
  assert.equal(stats.def_st_td, .05);
  // `st_td`, `st_ff` and `st_fum_rec` belong to a rostered returner's own line, never to the unit.
  for (const key of ['st_td', 'st_ff', 'st_fum_rec', 'st_tkl_solo']) assert.equal(stats[key], undefined, key);
  const contributions = new Map(score(f).contributions.map(c => [c.stat, c]));
  assert.equal(contributions.get('def_td')!.points, 1.5);
  near(contributions.get('def_st_td')!.points, .3);
  assert.equal(contributions.has('st_td'), false);
  // Moving a touchdown between phases moves it between rates, proving the fields are not interchanged.
  const moved = structuredClone(f); moved.defensiveTouchdowns = .3; moved.specialTeams!.touchdowns = 0;
  near(score(moved, { def_st_td: 2 }).points - score(f, { def_st_td: 2 }).points, .3 * 6 - .25 * 6 - .05 * 2);
  assert.throws(() => score(f, {}, { st_td: 1 }), /individual special-teams rule/);
  assert.throws(() => score(f, {}, { st_fum_rec: 1 }), /def_st_td, def_st_ff and def_st_fum_rec/);
  // Team special-teams rules the league actually scores may not be left at an assumed zero.
  const noSpecialTeams = structuredClone(f); delete noSpecialTeams.specialTeams;
  assert.throws(() => score(noSpecialTeams), /def_st_td\) is active in live scoring/);
  near(score(noSpecialTeams, { def_st_td: 0, def_st_ff: 0, def_st_fum_rec: 0 }).points, 8);
});

test('shutout and yardage bonuses are probability-weighted, never granted on a favorable matchup', () => {
  const f = forecast();
  const d = score(f).defense!;
  near(d.pointsAllowed.shutoutProbability, .06);
  near(d.pointsAllowed.tiers[0].points, .48);      // 6% × 8, not 8
  near(d.pointsAllowed.expectedPoints, .48);
  near(d.yardsAllowed.under100Probability, .04);
  near(d.yardsAllowed.tiers[0].points, .12);       // 4% × 3, not 3
  assert.match(d.pointsAllowed.explanation, /6% chance of a shutout earns 0\.48 of the 8-point bonus/);
  assert.match(d.yardsAllowed.explanation, /4% chance of under 100 yards earns 0\.12 of the 3-point bonus/);
  // The full bonus is reachable only at certainty, and it scales linearly with probability in between.
  const certain = structuredClone(f);
  certain.pointsAllowed = { buckets: only(PTS, '0') as DefenseForecast['pointsAllowed']['buckets'] };
  certain.yardsAllowed = { buckets: only(YDS, '0_100') as DefenseForecast['yardsAllowed']['buckets'] };
  near(score(certain).defense!.thresholdPoints, 11);
  const half = structuredClone(f);
  half.pointsAllowed.buckets = { '0': .5, '1_6': .1, '7_13': .1, '14_20': .1, '21_27': .1, '28_34': .05, '35p': .05 };
  near(score(half).defense!.pointsAllowed.tiers[0].points, 4);
  // A defense that cannot shut anyone out gets no part of the bonus, and the tier stays disclosed.
  const leaky = structuredClone(f);
  leaky.pointsAllowed.buckets = { '0': 0, '1_6': .05, '7_13': .15, '14_20': .25, '21_27': .25, '28_34': .2, '35p': .1 };
  near(score(leaky).defense!.pointsAllowed.expectedPoints, 0);
  assert.equal(score(leaky).defense!.pointsAllowed.tiers.length, 7);
  // Optimistic *context* alone never moves a single point of the total.
  const favorable = structuredClone(f);
  favorable.context = { ...favorable.context!, opponentQuarterback: { status: 'backup' }, opponentOffensiveLine: { startersOut: 4 }, opponentPressure: { sackRateAllowed: .12, pressureRateAllowed: .4 } };
  near(score(favorable).points, score(f).points);
});

test('tier distributions are complete and normalized, and a supplied mean must fit its own tiers', () => {
  const f = forecast();
  assert.equal(PTS.every(b => Object.hasOwn(defenseStats(f), `pts_allow_${b}`)), true);
  assert.equal(YDS.every(b => Object.hasOwn(defenseStats(f), `yds_allow_${b}`)), true);
  // Only tiers this league defines survive normalization; the rest never reach the unit check.
  const normalized = normalizeDefenseStats(rules(), {}, f);
  assert.equal(normalized.pts_allow_0, .06);
  assert.equal(normalized.yds_allow_0_100, .04);
  assert.equal(Object.hasOwn(normalized, 'pts_allow_1_6'), false);
  const broken = structuredClone(f); broken.pointsAllowed.buckets['35p'] = .3;
  assert.throws(() => validateDefenseForecast(broken), /sum to 1/);
  const partial = structuredClone(f);
  delete (partial.yardsAllowed.buckets as Partial<DefenseForecast['yardsAllowed']['buckets']>)['550p'];
  assert.throws(() => validateDefenseForecast(partial), /unknown field|probability from 0 to 1/);
  // The mean and the distribution describe one game, so an impossible pairing is refused.
  const optimistic = structuredClone(f); optimistic.pointsAllowed.expected = 5;
  assert.throws(() => validateDefenseForecast(optimistic), /impossible under its own tier probabilities/);
  optimistic.pointsAllowed.expected = 17;
  validateDefenseForecast(optimistic);
  assert.throws(() => score(f, { pts_allow: -1 }), /pts_allow is active in live scoring/);
  assert.throws(() => score(f, { yds_allow: -.05 }), /yds_allow is active in live scoring/);
  near(score(optimistic, { pts_allow: -1 }).points, 8.55 - 17);
  const withYards = structuredClone(optimistic); withYards.yardsAllowed.expected = 300;
  near(score(withYards, { pts_allow: -1, yds_allow: -.05 }).points, 8.55 - 17 - 15);
  // A per-point or per-yard rule is usually the largest single component; it must reach the drivers.
  const d = score(withYards, { pts_allow: -1, yds_allow: -.05 }).defense!;
  assert.deepEqual(d.drivers.slice(0, 2).map(v => v.label), ['Points allowed', 'Yards allowed']);
  near(d.drivers[0].points, .48 - 17);
  near(d.drivers[1].points, .12 - 15);
  assert.match(d.drivers[0].explanation, /per-unit pts_allow rule adds 17 × -1 = -17 points/);
  near(d.thresholdPoints, .48 - 17 + .12 - 15);
});

test('the adapter and the boundary refuse malformed, pre-scored or multiplier-adjusted defenses', () => {
  const mutations: Array<(f: DefenseForecast) => void> = [
    f => { f.sacks = -1; },
    f => { f.interceptions = NaN; },
    f => { f.sacks = 60; },
    f => { f.defensiveTouchdowns = 9; },
    f => { f.pointsAllowed.buckets['0'] = 1.4; },
    f => { f.yardsAllowed.buckets['200_299'] = .9; },
    f => { f.pointsAllowed.expected = 1; },
    f => { f.specialTeams!.touchdowns = -.5; },
    f => { (f as unknown as Record<string, unknown>).points = 12; },
    f => { (f as unknown as Record<string, unknown>).projectedPoints = 12; },
    f => { f.context!.opponentQuarterback = { status: 'injured' as never }; },
    f => { f.context!.opponentPressure!.sackRateAllowed = 4; },
    f => { f.context!.opponentOffensiveLine = { startersOut: 9 }; },
    f => { f.context!.game = { licensed: false, source: 'Unlicensed', impliedOpponentPoints: 20, spread: -3 } as never; },
    f => { f.context!.specialTeams = { returnOpportunities: 4, opponentReturnYardsAllowed: 900 }; },
  ];
  for (const mutate of mutations) {
    const value = input(); mutate(value.signals!.players[0].weeks[0].defense!);
    assert.throws(() => parseWaiverSignals(value.signals));
    assert.ok(boundary(value).rejected.some(r => r.playerId === value.signals!.players[0].playerId));
  }
  const value = input(); const w = value.signals!.players[0].weeks[0];
  delete w.defense; w.stats = { sack: 3, int: 1 };
  assert.match(boundary(value).rejected[0].message, /complete points\/yards-allowed tier probabilities/);
  w.defense = forecast(); w.stats = { projectedPoints: 12 };
  assert.equal(boundary(value).rejected[0].kind, 'pre-scored');
  // A blanket matchup multiplier would scale a probability-weighted bonus linearly. It is refused.
  w.stats = {}; w.matchupMultiplier = 1.2;
  assert.match(boundary(value).rejected[0].message, /multipliers are unsupported/);
  delete w.matchupMultiplier;
  value.signals!.players[0].role = { recentShare: .8, previousShare: .4, games: 4 };
  assert.match(boundary(value).rejected[0].message, /multipliers are unsupported/);
  // Overlapping provider counts are alternate descriptions of the same events, never extra ones.
  const f = forecast();
  assert.equal(score(f, {}, { sack: 2.5, ff: .9, fum_rec: .6, def_td: .25 }).points, score(f).points);
  assert.throws(() => score(f, {}, { ff: 1.4 }), /conflicts with its forecast/);
  assert.throws(() => score(f, {}, { pts_allow_0: .5 }), /conflicts with its forecast/);
});

function input() {
  const value = demoWaiverInput(now);
  value.league.rosterPositions = ['DEF', 'BN', 'BN', 'BN', 'BN', 'BN'].map((position, slot) => ({ position, slot }));
  value.rosters[0].starterIds = ['starter-rb'];
  for (const p of value.players) { p.position = 'DEF'; p.fantasyPositions = ['DEF']; p.injuryStatus = null; }
  for (const s of value.signals!.players) {
    s.role = undefined; s.recentTargets = undefined; s.dynastyStats = {}; s.dynastyDefense = forecast();
    s.weeks = s.weeks.map(w => ({ week: w.week, bye: false, opponent: 'TEST', stats: {}, defense: forecast() }));
  }
  return value;
}
const boundary = (value: ReturnType<typeof input>) => scoreLeagueForecasts({ rules: rules(), signals: value.signals!, players: value.players, availability: { policy: 'selected-week', selectedWeek: 8 } });

test('scenarios and dynasty use the identical contract, and scoring never mutates provider input', () => {
  const value = input(); const s = value.signals!.players[0]; const w = s.weeks[0];
  w.floorStats = {}; w.floorDefense = forecast(); w.floorDefense.sacks = 1;
  w.ceilingStats = {}; w.ceilingDefense = forecast(); w.ceilingDefense.sacks = 5;
  parseWaiverSignals(value.signals);
  const saved = structuredClone(value.signals);
  const p = boundary(value).players[0];
  near(p.weeks[0].floor!.points, 7.05);
  near(p.weeks[0].ceiling!.points, 11.05);
  near(p.dynasty!.defense!.expectedPoints, 8.55);
  assert.deepEqual(value.signals, saved);
  // A ceiling distribution may be a point mass: "they pitch a shutout" is a legitimate best case.
  w.ceilingDefense.pointsAllowed = { buckets: only(PTS, '0') as DefenseForecast['pointsAllowed']['buckets'] };
  near(boundary(value).players[0].weeks[0].ceiling!.defense!.pointsAllowed.expectedPoints, 8);
  w.floorDefense.sacks = 20;
  assert.equal(boundary(value).players[0].weeks[0].floor, null);
  delete w.floorDefense;
  assert.ok(boundary(value).rejected.length);
});

test('byes and unavailable units zero expected points while keeping the forecast visible', () => {
  const value = input(); const w = value.signals!.players[0].weeks[0]; w.bye = true;
  let scored = weekPoints(rules(), boundary(value).players[0].weeks[0]);
  assert.equal(scored.points, 0);
  const d = scored.defense!;
  assert.equal(d.expectedPoints, 0);
  assert.equal(d.turnoverPoints + d.pressurePoints + d.thresholdPoints + d.specialTeamsPoints, 0);
  assert.ok(d.components.every(c => c.points === 0) && d.pointsAllowed.tiers.every(t => t.points === 0));
  // The provider's counts and probabilities survive so a manager can still read why it was ranked.
  assert.equal(d.components.find(c => c.stat === 'sack')!.amount, 2.5);
  near(d.pointsAllowed.shutoutProbability, .06);
  assert.match(d.availabilityNote!, /before availability/);
  assert.ok(d.drivers.every(v => v.points === 0 && v.explanation.startsWith('Before availability:')));
  w.bye = false; value.signals!.players[0].injuryStatus = 'Out';
  assert.equal(weekPoints(rules(), boundary(value).players[0].weeks[0]).points, 0);
});

test('streamer factors read pressure, takeaways, line health, quarterback, script and both thresholds', () => {
  const f = forecast();
  const profile = () => defenseStreamerProfile(score(f).defense!);
  const base = profile();
  // Every context term starts neutral, so the baseline is the two threshold preferences alone.
  near(base.rankingAdjustment, .03);
  assert.equal(base.factors.filter(v => v.value !== 0).length, 2);
  const better = (mutate: (v: DefenseForecast) => void) => { const before = profile().rankingAdjustment; mutate(f); assert.ok(profile().rankingAdjustment > before, 'expected a stronger preference'); };
  better(v => { v.context!.opponentPressure = { sackRateAllowed: .1, pressureRateAllowed: .32 }; });
  better(v => { v.context!.opponentTurnovers = { interceptionRate: .04, fumbleRate: .022 }; });
  better(v => { v.context!.opponentOffensiveLine = { startersOut: 3, continuity: .5 }; });
  better(v => { v.context!.opponentQuarterback = { status: 'backup', name: 'Test backup' }; });
  better(v => { v.context!.specialTeams = { returnOpportunities: 7, opponentReturnYardsAllowed: 14, opponentMuffRate: .04 }; });
  better(v => { v.context!.game = { licensed: true, source: 'Licensed test feed', impliedOpponentPoints: 14, spread: -7 }; });
  const favorable = profile().rankingAdjustment;
  // Game script cuts both ways: a heavy underdog rushes fewer opponent dropbacks.
  f.context!.game = { licensed: true, source: 'Licensed test feed', impliedOpponentPoints: 30, spread: 10 };
  assert.ok(profile().rankingAdjustment < favorable);
  // Threshold preferences respond to the forecast's own probabilities, not to a matchup opinion.
  const shutoutHeavy = structuredClone(f);
  shutoutHeavy.pointsAllowed.buckets = { '0': .3, '1_6': .2, '7_13': .2, '14_20': .15, '21_27': .1, '28_34': .05, '35p': 0 };
  assert.ok(defenseStreamerProfile(score(shutoutHeavy).defense!).factors.find(v => v.label === 'Shutout probability')!.value
    > base.factors.find(v => v.label === 'Shutout probability')!.value);
  // Declared-included context earns no second preference; the descriptions stay visible.
  f.context!.includedInForecast = true;
  const gated = ['Opponent pressure and sack exposure', 'Opponent interception and fumble rates', 'Opponent offensive-line health', 'Opponent starting quarterback', 'Opponent implied scoring', 'Expected game script', 'Special-teams opportunity and opponent weakness'];
  assert.ok(profile().factors.filter(v => gated.includes(v.label)).every(v => v.value === 0));
  assert.ok(profile().factors.filter(v => gated.includes(v.label)).every(v => v.explanation.includes('Already included')));
  near(score(f).points, 8.55, 'context preferences never rewrite projected points');
  delete f.context;
  assert.equal(profile().missingContext.length, 6);
  assert.equal(profile().factors.some(v => gated.includes(v.label)), false);
  near(profile().rankingAdjustment, .03);
});

test('waiver streamers rank on the unit’s own forecast and context, not on team reputation', () => {
  const value = input();
  value.rosters[0].starterIds = ['0'];
  value.rosters[0].playerIds = []; value.rosters[0].reserveIds = []; value.rosters[0].taxiIds = [];
  const candidate = value.signals!.players.find(s => s.playerId === 'add-rb')!;
  const row = () => recommendWaivers(value).recommendations.find(r => r.add.id === candidate.playerId && r.horizon === 'streamer')!;
  const baseline = row();
  assert.ok(baseline); assert.equal(baseline.projectedPoints, 8.6);
  near(baseline.defense!.forecast.turnoverPoints, 3.1);
  assert.ok(baseline.reasons.some(r => r.includes('Sacks: 2.5 × 1 = 2.5 points.')));
  assert.equal(baseline.opportunity, null);
  for (const w of candidate.weeks) w.defense!.context!.opponentQuarterback = { status: 'backup' };
  assert.ok(row().score > baseline.score);
  assert.equal(row().projectedPoints, baseline.projectedPoints, 'context moves priority, never points');
  const named = value.players.find(p => p.id === candidate.playerId)!;
  named.fullName = 'Famous historic defense'; named.team = 'SF';
  assert.equal(row().score, row().score);
  const withReputation = row().score;
  for (const w of candidate.weeks) w.defense!.sacks = 5;
  assert.ok(row().projectedPoints > baseline.projectedPoints);
  assert.ok(row().score > withReputation);
  // Receiving metadata cannot sway a unit that has no receiving role.
  candidate.recentTargets = [1, 2, 10, 20, 25, 30];
  const unswayed = row().score;
  candidate.weeks[0].opportunity = { targets: 20, routes: 30, targetShare: .9 };
  assert.equal(row().score, unswayed);
  delete candidate.weeks[0].defense;
  assert.equal(row(), undefined);
});

test('live scoring rates, not matchup opinion, decide which defense a streamer prefers', () => {
  const value = input();
  value.rosters[0].starterIds = ['0']; value.rosters[0].playerIds = []; value.rosters[0].reserveIds = []; value.rosters[0].taxiIds = [];
  const takeaways = value.signals!.players.find(s => s.playerId === 'add-rb')!;
  const shutouts = value.signals!.players.find(s => s.playerId === 'add-wr')!;
  for (const s of [takeaways, shutouts]) for (const w of s.weeks) {
    const d = w.defense!;
    d.sacks = 0; d.interceptions = s === takeaways ? 2 : 0; d.forcedFumbles = 0; d.fumbleRecoveries = 0;
    d.safeties = 0; d.blockedKicks = 0; d.defensiveTouchdowns = 0;
    d.specialTeams = { touchdowns: 0, forcedFumbles: 0, fumbleRecoveries: 0 };
    d.pointsAllowed.buckets = s === shutouts
      ? { '0': .5, '1_6': .2, '7_13': .1, '14_20': .1, '21_27': .05, '28_34': .05, '35p': 0 }
      : { '0': 0, '1_6': .1, '7_13': .2, '14_20': .3, '21_27': .2, '28_34': .15, '35p': .05 };
  }
  const find = (id: string) => recommendWaivers(value).recommendations.filter(r => r.horizon === 'streamer').find(r => r.add.id === id)!;
  // 50% × 8 = 4.0 shutout points beats 2 interceptions × 2 = 4.0 only once the bonus rate rises.
  assert.ok(find(shutouts.playerId).score > find(takeaways.playerId).score);
  value.league.scoring = rules({ pts_allow_0: 2, int: 6 }).configuration;
  assert.ok(find(shutouts.playerId).score < find(takeaways.playerId).score);
});
