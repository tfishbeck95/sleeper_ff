import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, interpretScoring, type ScoringConfiguration } from '@sleeper/domain';
import { scoreQuarterback, quarterbackOutlook } from './quarterback.js';
import { scoreLeagueForecasts } from './projection-scoring.js';
import { parseWaiverSignals } from './waiver-signals.js';
import { demoLineupInput, demoWaiverInput, demoTradeInput } from './test-support/scoring-fixtures.js';
import { analyzeLineup } from './lineup.js';
import { recommendWaivers } from './waivers.js';
import { recommendTrades } from './trades.js';

const now = new Date('2026-09-08T12:00:00Z');
const pocket = { pass_yd: 300, pass_td: 2, pass_int: 1, rush_yd: 0, rush_td: 0 };
const runner = { pass_yd: 200, pass_td: 1, pass_int: 1, rush_yd: 70, rush_td: 1 };
const floor = { pass_yd: 140, pass_td: 0, pass_int: 2, rush_yd: 20, rush_td: 0 };
const ceiling = { pass_yd: 300, pass_td: 3, pass_int: 0, rush_yd: 100, rush_td: 2 };
const split = { designedRuns: { yards: 40, touchdowns: 1 }, scrambles: { yards: 30, touchdowns: 0 } };
// Already-validated configurations let arithmetic tests vary exact rates independently of sync validation.
const rules = (rates = {}) => interpretScoring([], { kind: 'complete-live', settings: { ...EXPECTED_SCORING, ...rates }, rawSettings: {}, synchronizedAt: now.toISOString(), issues: [] } as ScoringConfiguration);

test('QB components reconcile, include zeroes and other rules, and never double-count rushing subsets', () => {
  const score = scoreQuarterback(rules(), { ...runner, fum_lost: 1, pass_2pt: 1 }, split);
  const qb = score.quarterback!;
  assert.equal(score.points, 23);
  assert.deepEqual([qb.passingTouchdowns?.points, qb.passingYards?.points, qb.interceptions?.points, qb.rushingYards?.points, qb.rushingTouchdowns?.points], [4, 8, -2, 7, 6]);
  assert.equal(qb.designedRuns!.reduce((s, c) => s + c.points, 0), 10);
  assert.equal(qb.scrambles!.reduce((s, c) => s + c.points, 0), 3);
  assert.equal(qb.turnoverPoints, -4);
  assert.equal(qb.otherPoints, 0);
  assert.equal(scoreQuarterback(rules(), runner).points, scoreQuarterback(rules(), runner, split).points);
  assert.match(qb.explanation, /Projected turnovers reduce the total by 4/);
  assert.equal(scoreQuarterback(rules(), pocket).quarterback!.rushingYards!.points, 0);
  assert.equal(scoreQuarterback(rules(), { pass_yd: 100 }).quarterback!.rushingYards, null);
  const withBonus = scoreQuarterback(rules({ bonus_rush_yd_100: 3 }), { ...runner, bonus_rush_yd_100: 1 }).quarterback!;
  assert.equal(withBonus.otherPoints, 3); assert.equal(withBonus.rushingPoints, 16); assert.equal(withBonus.totalPoints, 26);
});

test('exact league rates can reverse QB rankings without a rushing category bonus', () => {
  assert.ok(scoreQuarterback(rules(), runner).points > scoreQuarterback(rules(), pocket).points);
  const passingLeague = rules({ pass_td: 8, pass_yd: .06, rush_yd: .02, rush_td: 2, pass_int: -4 });
  assert.ok(scoreQuarterback(passingLeague, runner).points < scoreQuarterback(passingLeague, pocket).points);
  assert.equal(scoreQuarterback(passingLeague, runner, split).quarterback!.designedRuns![1].points, 2);
  assert.equal(scoreQuarterback(passingLeague, floor).points, .8);
  assert.equal(scoreQuarterback(passingLeague, ceiling).points, 48);
});

function setup<T extends ReturnType<typeof demoWaiverInput>>(input: T): T {
  input.league.rosterPositions = ['QB', 'BN', 'BN', 'BN', 'BN', 'BN'].map((position, slot) => ({ position, slot }));
  for (const p of input.players) { p.position = 'QB'; p.fantasyPositions = ['QB']; p.injuryStatus = null; }
  input.rosters[0].starterIds = ['starter-rb'];
  for (const s of input.signals!.players) {
    s.role = undefined; s.recentTargets = undefined;
    s.weeks = s.weeks.map(w => ({ week: w.week, bye: false, opponent: 'SAMPLE', matchupMultiplier: 1, stats: s.playerId === 'starter-rb' ? pocket : { pass_yd: 50 } }));
  }
  return input;
}

test('weekly QB ranges retain exact scenario scoring, including adjustments and unavailable splits', () => {
  const input = setup(demoWaiverInput(now));
  const s = input.signals!.players[0];
  s.weeks[0] = { week: 8, bye: false, stats: runner, floorStats: floor, ceilingStats: ceiling, rushingSplit: split, matchupMultiplier: 1.1 };
  const score = () => scoreLeagueForecasts({ rules: rules(), signals: input.signals!, players: input.players });
  const outlook = quarterbackOutlook(score().players[0].weeks[0])!;
  assert.equal(outlook.mean.totalPoints, 25.3); assert.equal(outlook.floor!.totalPoints, 3.96); assert.equal(outlook.ceiling!.totalPoints, 50.6);
  assert.equal(outlook.floor!.designedRuns, null);
  assert.equal(outlook.floor!.interceptions!.points, -4.4);
  s.weeks[0].floorStats = { ...runner, rush_td: 10 };
  assert.equal(quarterbackOutlook(score().players[0].weeks[0])!.floor, null);
  s.weeks[0].bye = true;
  assert.equal(quarterbackOutlook(score().players[0].weeks[0])!.mean.rushingPoints, 0);
});

test('invalid or pre-scored rushing splits fail parser and direct scoring boundary', () => {
  const input = setup(demoWaiverInput(now));
  const w = input.signals!.players[0].weeks[0];
  w.stats = runner; w.rushingSplit = { designedRuns: { yards: 50 }, scrambles: { yards: 30 } };
  assert.throws(() => parseWaiverSignals(input.signals), /exceeds/);
  assert.ok(scoreLeagueForecasts({ rules: rules(), signals: input.signals!, players: input.players }).rejected.some(r => /Rushing split/.test(r.message)));
  w.rushingSplit = { designedRuns: { points: 5 } } as never;
  assert.throws(() => parseWaiverSignals(input.signals), /Invalid rushing split/);
});

test('starting QB comparison and replacement baseline use rushing and turnover components', () => {
  const input = setup(demoLineupInput(now));
  input.signals!.players.find(s => s.playerId === 'bench-1')!.weeks[0].stats = runner;
  input.signals!.players.find(s => s.playerId === 'bench-2')!.weeks[0].stats = { pass_yd: 250 };
  input.signals!.players.find(s => s.playerId === 'bench-3')!.weeks[0].stats = { pass_yd: 200 };
  const report = analyzeLineup(input);
  assert.equal(report.startSit[0].start.playerId, 'bench-1');
  assert.equal(report.startSit[0].advantage, 5);
  assert.match(report.startSit[0].explanation, /Rushing production drives the higher ranking/);
  assert.equal(report.startSit[0].start.quarterback!.mean.rushingPoints, 13);
  assert.ok(report.replacementLevels.QB.quarterback);
  assert.match(report.replacementLevels.QB.explanation, /QB points:/);
  assert.equal(report.replacementLevels.QB.score, 10);
  input.signals!.players.find(s => s.playerId === 'bench-1')!.weeks[0].stats = { ...runner, pass_int: 10 };
  assert.equal(analyzeLineup(input).replacementLevels.QB.score, 8);
});

test('waiver streamer rankings move with raw rushing and interception forecasts', () => {
  const input = setup(demoWaiverInput(now));
  const candidate = input.signals!.players.find(s => s.playerId === 'add-rb')!;
  candidate.weeks.forEach(w => { w.stats = runner; });
  const row = recommendWaivers(input).recommendations.find(r => r.add.id === candidate.playerId && r.horizon === 'streamer')!;
  assert.equal(row.projectedPoints, 23); assert.equal(row.quarterback!.mean.rushingPoints, 13);
  assert.match(row.reasons.join(' '), /Rushing production drives the higher ranking/);
  candidate.weeks.forEach(w => { w.stats = { ...runner, pass_int: 5 }; });
  assert.equal(recommendWaivers(input).recommendations.filter(r => r.add.id === candidate.playerId && r.horizon === 'streamer').length, 0);
});

test('trade assets expose scored QB weeks and their value falls with projected turnovers', () => {
  const input = demoTradeInput(now);
  for (const p of input.players.filter(p => p.position === 'RB')) { p.position = 'QB'; p.fantasyPositions = ['QB']; }
  input.league.rosterPositions[0].position = 'QB';
  const signal = input.signals!.players.find(s => s.playerId === 'o-depth')!;
  signal.weeks.forEach(w => { w.stats = runner; w.floorStats = floor; w.ceilingStats = ceiling; w.rushingSplit = split; });
  const asset = () => recommendTrades(input).teams.flatMap(t => t.surplus).find(a => a.id === 'o-depth')!;
  // Keep this player on the bench so the asset remains observable independent of offer search.
  input.signals!.players.find(s => s.playerId === 'o-rb')!.weeks.forEach(w => { w.stats = { pass_yd: 500, pass_td: 4 }; });
  const before = asset();
  assert.ok(before.quarterbackWeeks?.length); assert.equal(before.quarterbackWeeks![0].breakdown.mean.totalPoints, 23);
  signal.weeks.forEach(w => { w.stats = { ...runner, pass_int: 2 }; });
  assert.ok(asset().value < before.value);
});


test('dynasty QB attribution and optional subsets use the future raw stat line', () => {
  const input = setup(demoWaiverInput(now));
  const signal = input.signals!.players[0];
  signal.dynastyStats = runner; signal.dynastyRushingSplit = split;
  const result = scoreLeagueForecasts({ rules: rules(), signals: parseWaiverSignals(input.signals), players: input.players });
  assert.equal(result.players[0].dynasty!.points, 23);
  assert.equal(result.players[0].dynasty!.quarterback!.designedRuns![0].points, 4);
});
