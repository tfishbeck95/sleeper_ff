import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, interpretScoring, liveScoring, referenceScoring, scoringSnapshotId } from '@sleeper/domain';
import type { NflPlayer } from '@sleeper/domain';
import { scoreLeagueForecasts, TRADE_UNAVAILABLE_STATUSES, weekPoints } from './projection-scoring.js';
import type { PlayerSignal, WaiverSignals } from './waiver-signals.js';
import { parseWaiverSignals } from './waiver-signals.js';

const at = '2026-09-08T12:00:00Z';
const scoring = liveScoring({ ...EXPECTED_SCORING }, at);
const rules = interpretScoring([], scoring);
const meta = { sourceUpdatedAt: null, synchronizedAt: at };
const player = (id: string, overrides: Partial<NflPlayer> = {}): NflPlayer => ({ id, fullName: `Player ${id}`, firstName: null, lastName: null, team: 'SAMPLE', position: 'WR', fantasyPositions: ['WR'], status: 'Active', injuryStatus: null, ...meta, ...overrides });
const signals = (players: PlayerSignal[]): WaiverSignals => ({ season: '2026', week: 8, source: 'Test feed', updatedAt: at, players });
const week = (overrides: Partial<PlayerSignal['weeks'][number]> = {}) => ({ week: 8, bye: false, stats: { rec: 8, rec_yd: 124, rec_td: 1 }, ...overrides });

test('raw statistics become league-scored points carrying the snapshot, the sentence and the drivers', () => {
  const scored = scoreLeagueForecasts({
    rules, signals: signals([{ playerId: 'a', weeks: [week()], dynastyStats: { rec: 6, rec_yd: 75 } }]),
    players: [player('a')], requiredWeeks: [8],
  });
  const only = scored.players[0]!;
  assert.deepEqual(scored.rejected, []);
  assert.equal(only.weeks[0].mean.points, 26.4);
  assert.equal(only.weeks[0].mean.explanation, "26.4 points under your league's full-PPR scoring");
  assert.match(only.weeks[0].mean.breakdown, /8 rec × 1 = 8\.00/);
  assert.deepEqual(only.weeks[0].mean.contributions.map(c => c.stat), ['rec_yd', 'rec', 'rec_td']);
  assert.equal(only.scoringSnapshotId, scoringSnapshotId(scoring));
  assert.equal(only.forecastUpdatedAt, at);
  assert.equal(scored.scoringLabel, 'full-PPR');
  assert.equal(only.dynasty!.points, 13.5);
});

test('floor and ceiling raw-stat scenarios are scored by exactly the same rule set', () => {
  const scored = scoreLeagueForecasts({
    rules, players: [player('a')], requiredWeeks: [8],
    signals: signals([{ playerId: 'a', weeks: [week({ floorStats: { rec: 4, rec_yd: 40 }, ceilingStats: { rec: 11, rec_yd: 180, rec_td: 2 } })] }]),
  });
  const only = scored.players[0]!.weeks[0];
  assert.equal(only.floor!.points, 8); assert.equal(only.ceiling!.points, 41);
  assert.equal(only.floorPoints, 8); assert.equal(only.ceilingPoints, 41);
  assert.match(only.floor!.explanation, /8\.0 points under your league's full-PPR scoring/);
  // Nothing is fabricated when a scenario is absent.
  const bare = scoreLeagueForecasts({ rules, players: [player('a')], signals: signals([{ playerId: 'a', weeks: [week()] }]) });
  assert.equal(bare.players[0].weeks[0].floor, null);
  assert.equal(bare.players[0].weeks[0].ceilingPoints, null);
});

test('a pre-scored total, an unknown stat unit or an unverifiable identity is refused, never defaulted', () => {
  const refusals = (signal: PlayerSignal, directory = [player('a')]) => scoreLeagueForecasts({ rules, players: directory, signals: signals([signal]) });
  const preScored = refusals({ playerId: 'a', weeks: [week({ stats: { projectedPoints: 18.4 } })] });
  assert.deepEqual(preScored.players, []);
  assert.equal(preScored.rejected[0].kind, 'pre-scored');
  assert.match(preScored.rejected[0].message, /pre-scored fantasy total/);
  const unknownUnit = refusals({ playerId: 'a', weeks: [week({ stats: { targets: 9 } })] });
  assert.equal(unknownUnit.rejected[0].kind, 'units');
  assert.match(unknownUnit.rejected[0].message, /this league's scoring rules do not define/);
  const unknownPlayer = refusals({ playerId: 'ghost', weeks: [week()] });
  assert.equal(unknownPlayer.rejected[0].kind, 'identity');
  assert.match(unknownPlayer.rejected[0].message, /no synchronized Sleeper player/);
  const positionless = refusals({ playerId: 'a', weeks: [week()] }, [player('a', { position: null, fantasyPositions: [] })]);
  assert.equal(positionless.rejected[0].kind, 'identity');
  const uncovered = scoreLeagueForecasts({ rules, players: [player('a')], requiredWeeks: [8, 9], signals: signals([{ playerId: 'a', weeks: [week()] }]) });
  assert.equal(uncovered.rejected[0].kind, 'coverage');
  assert.deepEqual(uncovered.players, []);
  // A refused scenario loses the scenario only; the validated mean survives and the refusal is reported.
  const inverted = refusals({ playerId: 'a', weeks: [week({ ceilingStats: { rec: 1 } })] });
  assert.equal(inverted.rejected[0].kind, 'scenario');
  assert.equal(inverted.players[0].weeks[0].ceiling, null);
  assert.equal(inverted.players[0].weeks[0].mean.points, 26.4);
});

test('availability differs by consumer and bounded trends change raw stats before scoring exactly once', () => {
  const signal: PlayerSignal = { playerId: 'a', weeks: [week(), week({ week: 9 })], injuryStatus: 'Out' };
  const streaming = scoreLeagueForecasts({ rules, players: [player('a')], signals: signals([signal]), availability: { policy: 'selected-week', selectedWeek: 8 } });
  assert.equal(streaming.players[0].weeks[0].points, 0);
  assert.equal(streaming.players[0].weeks[1].points, 26.4, 'a later week is not zeroed by an undated designation');
  assert.match(streaming.players[0].weeks[0].adjustments[0], /zeroes the league-scored forecast/);
  const valuation = scoreLeagueForecasts({ rules, players: [player('a')], signals: signals([signal]), availability: { policy: 'entire-horizon', statuses: TRADE_UNAVAILABLE_STATUSES } });
  assert.equal(valuation.players[0].weeks[1].points, 0, 'trade valuation stays conservative for the whole horizon');
  const adjusted = scoreLeagueForecasts({
    rules, players: [player('a')],
    signals: signals([{ playerId: 'a', weeks: [week({ forecastAdjustments: [{ trendId: 'target-share-week-8', label: 'Target share rose', input: 'targetShare', evidence: '18% to 24% over four games', baselineIncorporates: false, statChanges: { rec: 1, rec_yd: 12 }, maxAbsoluteStatChange: 12 }] })] }]),
  });
  const value = weekPoints(rules, adjusted.players[0].weeks[0]);
  assert.equal(value.points, 28.6, 'the adjusted reception and yards are scored once by league rules');
  assert.match(value.explanation, /changed raw stats by rec \+1, rec_yd \+12/);
  assert.match(value.explanation, /baseline did not incorporate it/);
  const incorporated = scoreLeagueForecasts({ rules, players: [player('a')], signals: signals([{ playerId: 'a', weeks: [week({ forecastAdjustments: [{ trendId: 'qb-change', label: 'New quarterback', input: 'quarterbackChange', evidence: 'backup announced', baselineIncorporates: true, statChanges: {}, maxAbsoluteStatChange: 1 }] })] }]) });
  assert.equal(incorporated.players[0].weeks[0].points, 26.4);
  assert.match(weekPoints(rules, incorporated.players[0].weeks[0]).explanation, /already incorporated.*no second adjustment applied/);
});

test('generic point multipliers and duplicate or unbounded trend adjustments are prohibited', () => {
  assert.throws(() => scoreLeagueForecasts({ rules, players: [player('a')], signals: signals([{ playerId: 'a', weeks: [week({ matchupMultiplier: 1.1 })] }]) }), /generic matchup point multipliers are prohibited/);
  const adjustment = { trendId: 'snap-rise', label: 'Snap rate rose', input: 'snapRate', evidence: '55% to 80%', baselineIncorporates: false, statChanges: { rec: 1 }, maxAbsoluteStatChange: 1 } as const;
  assert.throws(() => parseWaiverSignals(signals([{ playerId: 'a', weeks: [week({ forecastAdjustments: [adjustment, adjustment] })] }])), /duplicate forecast adjustment/);
  assert.throws(() => parseWaiverSignals(signals([{ playerId: 'a', weeks: [week({ forecastAdjustments: [{ ...adjustment, statChanges: { rec: 2 } }] })] }])), /unbounded/);
});

test('a scoring snapshot that cannot score refuses the whole boundary rather than guessing', () => {
  assert.throws(() => scoreLeagueForecasts({ rules: interpretScoring([], referenceScoring()), players: [player('a')], signals: signals([{ playerId: 'a', weeks: [week()] }]) }), /validated complete live scoring snapshot/);
});

test('opportunity is workload, never points: it may only narrow a supplied floor, within its bound', () => {
  const opportunity = { targets: 9, routes: 32, routeParticipation: .9, targetShare: .24, redZoneTargets: 2 };
  const scoredWith = (recentTargets?: number[]) => scoreLeagueForecasts({
    rules, players: [player('a')], requiredWeeks: [8],
    signals: signals([{ playerId: 'a', weeks: [week({ floorStats: { rec: 4, rec_yd: 40 }, ceilingStats: { rec: 11, rec_yd: 180, rec_td: 2 }, opportunity })], recentTargets }]),
  }).players[0].weeks[0];
  const bare = scoredWith(), steady = scoredWith([9, 8, 10, 9, 9, 8]), erratic = scoredWith([1, 14, 2, 13, 2, 12]);
  for (const value of [bare, steady, erratic]) {
    assert.equal(value.mean.points, 26.4, 'the mean is exactly what the league scored, in every case');
    assert.equal(value.ceiling!.points, 41, 'the ceiling is never moved by a role signal');
  }
  assert.equal(bare.floor!.points, 8); assert.equal(erratic.floor!.points, 8);
  assert.ok(steady.floor!.points > 8 && steady.floor!.points < 26.4);
  // The lift is capped: it can never recover more than a quarter of the floor-to-mean gap.
  assert.ok(steady.floor!.points <= 8 + (26.4 - 8) * .25 + 1e-9);
  assert.match(steady.floor!.explanation, /lifted 21% toward the mean for a 0\.922 target-stability score/);
  assert.ok(steady.adjustments.some(value => /The mean and ceiling are unchanged/.test(value)));
  const profile = scoreLeagueForecasts({
    rules, players: [player('a')], requiredWeeks: [8],
    signals: signals([{ playerId: 'a', weeks: [week({ opportunity })], recentTargets: [9, 8, 10, 9, 9, 8] }]),
  }).players[0].opportunity!;
  assert.equal(profile.targets, 9); assert.equal(profile.targetsPerRouteRun, .281);
  assert.equal(profile.routeParticipation, .9); assert.equal(profile.targetShare, .24); assert.equal(profile.redZoneTargets, 2);
  assert.equal(profile.receptionPoints, 8);
  assert.ok(profile.floorLift > 0, 'the profile reports the lift it caused');
});

test('a workload measure is never accepted as a scoring statistic', () => {
  const inStats = scoreLeagueForecasts({
    rules, players: [player('a')],
    signals: signals([{ playerId: 'a', weeks: [{ week: 8, bye: false, stats: { rec: 6, targets: 9 } }] }]),
  });
  assert.equal(inStats.rejected[0].kind, 'units');
  assert.match(inStats.rejected[0].message, /"targets", which this league's scoring rules do not define/);
  assert.deepEqual(inStats.players, [], 'targets belong in `opportunity`, never in a scored stat line');
});
