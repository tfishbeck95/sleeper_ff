import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretLeagueRules, scoreStartDecision } from './index.js';
test('scoreStartDecision rewards upward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'up' }), 15.7));
test('scoreStartDecision discounts downward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'down' }), 13.2));
test('interprets Sleeper roster, dynasty, playoff, and custom scoring settings', () => {
  const rules = interpretLeagueRules({
    previousLeagueId: 'old', seasonType: 'regular',
    scoringSettings: [{ key: 'rec', points: 1 }, { key: 'pass_yd', points: .04 }, { key: 'pass_td', points: 6 }],
    rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'SUPER_FLEX', 'BN', 'BN'].map((position, slot) => ({ position, slot })),
    settings: { type: 2, reserve_slots: 2, taxi_slots: 3, playoff_teams: 6, playoff_week_start: 15, league_average_match: 1 },
  });
  assert.equal(rules.format, 'dynasty'); assert.equal(rules.roster.benchSlots, 2); assert.equal(rules.roster.reserveSlots, 2); assert.equal(rules.roster.taxiSlots, 3);
  assert.deepEqual(rules.roster.eligiblePositions('SUPER_FLEX'), ['QB', 'RB', 'WR', 'TE']);
  assert.equal(rules.scoring.receptionFormat, 'ppr'); assert.deepEqual(rules.scoring.score({ pass_yd: 250, pass_td: 2 }), { points: 22, explanation: '250 pass_yd × 0.04 = 10.00; 2 pass_td × 6 = 12.00' });
  assert.equal(rules.playoffs.startsWeek, 15); assert.equal(rules.playoffs.matchupType, 'head-to-head-and-median'); assert.equal(rules.tradedDraftPicks, true);
});
