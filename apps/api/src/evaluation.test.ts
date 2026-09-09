import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretRoster, interpretScoring, liveScoring, scoringSnapshotId, EXPECTED_SCORING } from '@sleeper/domain';
import type { ScoredPoints } from '@sleeper/domain';
import { LeagueEvaluationService, type EvaluationPlayer } from './evaluation.js';

const at = '2026-09-08T12:00:00Z';
const scoring = liveScoring({ ...EXPECTED_SCORING }, at);
const rules = interpretScoring([], scoring);
/** Statistics only. Every point below is produced by applying this league's rules to them. */
const rushingFor = (points: number) => ({ rush_yd: points * 10 });
function player(id: string, name: string, positions: string[], points: number, extra: Partial<EvaluationPlayer> = {}): EvaluationPlayer {
  return {
    id, name, positions, projected: rules.score(rushingFor(points)), floor: null, ceiling: null,
    scoringSnapshotId: rules.snapshotId, forecastUpdatedAt: at, ...extra,
  };
}

test('evaluates lineups, exposure, dynasty assets, and league-relative strengths from league-scored points', () => {
  const players = [
    player('q1', 'Alpha QB', ['QB'], 25, { floor: rules.score(rushingFor(18)), ceiling: rules.score(rushingFor(32)), age: 25 }),
    player('r1', 'Alpha RB', ['RB'], 18, { age: 23, byeWeek: 7 }),
    player('r2', 'Bench RB', ['RB'], 10, { age: 29 }),
    player('q2', 'Beta QB', ['QB'], 17, { age: 34, injuryStatus: 'Out' }),
    player('r3', 'Beta RB', ['RB'], 12, { age: 27 }),
    player('r4', 'Depth RB', ['RB'], 6, { age: 30 }),
  ];
  const result = new LeagueEvaluationService().evaluate({
    scoring, rules: interpretRoster(['QB', 'RB', 'BN']), format: 'dynasty', week: 7, players,
    rosters: [{ rosterId: 1, name: 'Alpha', playerIds: ['q1', 'r1', 'r2'] }, { rosterId: 2, name: 'Beta', playerIds: ['q2', 'r3', 'r4'] }],
    tradedPicks: [{ id: 'pick', leagueId: 'l', season: '2027', round: 1, rosterId: 2, previousOwnerId: 2, ownerId: 1, synchronizedAt: '', sourceUpdatedAt: null }],
  });
  const alpha = result.rosters[0]!; const beta = result.rosters[1]!;
  assert.equal(alpha.projectedWeekly.score, 43); assert.match(alpha.projectedWeekly.explanation, /optimal eligible starters/);
  assert.match(alpha.projectedWeekly.explanation, /full-PPR scoring/);
  assert.equal(alpha.byeExposure.score, 1); assert.equal(alpha.futurePickCapital?.score, 4);
  assert.equal(beta.injuryExposure.score, 1); assert.ok(alpha.relativeStrengths.some(value => value.includes('above the league average')));
  assert.ok(Object.hasOwn(result.replacementLevels, 'QB'));
  assert.equal(result.scoringSnapshotId, scoringSnapshotId(scoring));
  assert.equal(result.scoringLabel, 'full-PPR');
  assert.equal(result.forecastUpdatedAt, at);
  assert.deepEqual(alpha.lineup.map(slot => [slot.slot, slot.name]), [['QB', 'Alpha QB'], ['RB', 'Alpha RB']]);
  for (const metric of [alpha.projectedWeekly, alpha.range, alpha.benchUtilization, alpha.expendableDepth]) assert.ok(metric.explanation.length > 10);
});

test('a floor/ceiling range is reported only from supplied scenarios and is never derived from the mean', () => {
  const service = new LeagueEvaluationService();
  const partial = service.evaluate({
    scoring, rules: interpretRoster(['QB', 'RB']), format: 'redraft', week: 1,
    rosters: [{ rosterId: 1, name: 'Alpha', playerIds: ['q1', 'r1'] }],
    players: [player('q1', 'Alpha QB', ['QB'], 25, { floor: rules.score(rushingFor(18)), ceiling: rules.score(rushingFor(32)) }), player('r1', 'Alpha RB', ['RB'], 18)],
  });
  assert.equal(partial.rosters[0].range.score, 0);
  assert.match(partial.rosters[0].range.explanation, /Alpha RB have no league-scored floor and ceiling scenario/);
  assert.equal(partial.rosters[0].floorPoints, null);
  const complete = service.evaluate({
    scoring, rules: interpretRoster(['QB', 'RB']), format: 'redraft', week: 1,
    rosters: [{ rosterId: 1, name: 'Alpha', playerIds: ['q1', 'r1'] }],
    players: [
      player('q1', 'Alpha QB', ['QB'], 25, { floor: rules.score(rushingFor(18)), ceiling: rules.score(rushingFor(32)) }),
      player('r1', 'Alpha RB', ['RB'], 18, { floor: rules.score(rushingFor(12)), ceiling: rules.score(rushingFor(24)) }),
    ],
  });
  assert.equal(complete.rosters[0].floorPoints, 30); assert.equal(complete.rosters[0].ceilingPoints, 56);
  assert.equal(complete.rosters[0].range.score, 26);
  assert.match(complete.rosters[0].range.explanation, /supplied floor and ceiling stat scenarios/);
});

test('points scored under another snapshot or without a forecast timestamp cannot rank this league', () => {
  const service = new LeagueEvaluationService();
  const foreign = interpretScoring([], liveScoring({ ...EXPECTED_SCORING }, '2020-01-01T00:00:00Z'));
  const evaluate = (players: EvaluationPlayer[]) => service.evaluate({
    scoring, rules: interpretRoster(['QB']), format: 'redraft', week: 1,
    rosters: [{ rosterId: 1, name: 'Alpha', playerIds: ['q1'] }], players,
  });
  assert.throws(() => evaluate([{ ...player('q1', 'Alpha QB', ['QB'], 25), scoringSnapshotId: foreign.snapshotId }]), /not this league's/);
  assert.throws(() => evaluate([{ ...player('q1', 'Alpha QB', ['QB'], 25), forecastUpdatedAt: 'whenever' }]), /no valid forecast timestamp/);
  assert.throws(() => evaluate([{ ...player('q1', 'Alpha QB', ['QB'], 25), projected: { points: Number.NaN } as ScoredPoints }]), /nonfinite/);
});
