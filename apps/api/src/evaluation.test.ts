import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretRoster } from '@sleeper/domain';
import { LeagueEvaluationService } from './evaluation.js';

test('evaluates lineups, exposure, dynasty assets, and league-relative strengths', () => {
  const players = [
    { id: 'q1', name: 'Alpha QB', positions: ['QB'], projectedPoints: 25, floor: 18, ceiling: 32, age: 25 },
    { id: 'r1', name: 'Alpha RB', positions: ['RB'], projectedPoints: 18, age: 23, byeWeek: 7 },
    { id: 'r2', name: 'Bench RB', positions: ['RB'], projectedPoints: 10, age: 29 },
    { id: 'q2', name: 'Beta QB', positions: ['QB'], projectedPoints: 17, age: 34, injuryStatus: 'Out' },
    { id: 'r3', name: 'Beta RB', positions: ['RB'], projectedPoints: 12, age: 27 },
    { id: 'r4', name: 'Depth RB', positions: ['RB'], projectedPoints: 6, age: 30 },
  ];
  const result = new LeagueEvaluationService().evaluate({
    rules: interpretRoster(['QB', 'RB', 'BN']), format: 'dynasty', week: 7, players,
    rosters: [{ rosterId: 1, name: 'Alpha', playerIds: ['q1', 'r1', 'r2'] }, { rosterId: 2, name: 'Beta', playerIds: ['q2', 'r3', 'r4'] }],
    tradedPicks: [{ id: 'pick', leagueId: 'l', season: '2027', round: 1, rosterId: 2, previousOwnerId: 2, ownerId: 1, synchronizedAt: '', sourceUpdatedAt: null }],
  });
  const alpha = result.rosters[0]!; const beta = result.rosters[1]!;
  assert.equal(alpha.projectedWeekly.score, 43); assert.match(alpha.projectedWeekly.explanation, /optimal eligible starters/);
  assert.equal(alpha.byeExposure.score, 1); assert.equal(alpha.futurePickCapital?.score, 4);
  assert.equal(beta.injuryExposure.score, 1); assert.ok(alpha.relativeStrengths.some(value => value.includes('above the league average')));
  assert.ok(Object.hasOwn(result.replacementLevels, 'QB'));
  for (const metric of [alpha.projectedWeekly, alpha.range, alpha.benchUtilization, alpha.expendableDepth]) assert.ok(metric.explanation.length > 10);
});
