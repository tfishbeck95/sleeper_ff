import { EXPECTED_SCORING, liveScoring } from './index.js';
const scoring = liveScoring({ ...EXPECTED_SCORING }, '2026-09-08T12:00:00Z');
import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretLeagueRules, scoreStartDecision } from './index.js';
test('scoreStartDecision rewards upward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'up' }, scoring), 15.7));
test('scoreStartDecision discounts downward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'down' }, scoring), 13.2));
test('interprets Sleeper roster, dynasty, playoff, and custom scoring settings', () => {
  const rules = interpretLeagueRules({
    scoring, previousLeagueId: 'old', seasonType: 'regular',
    scoringSettings: [{ key: 'rec', points: 1 }, { key: 'pass_yd', points: .04 }, { key: 'pass_td', points: 6 }],
    rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'SUPER_FLEX', 'BN', 'BN'].map((position, slot) => ({ position, slot })),
    settings: { type: 2, reserve_slots: 2, taxi_slots: 3, playoff_teams: 6, playoff_week_start: 15, league_average_match: 1 },
  });
  assert.equal(rules.format, 'dynasty'); assert.equal(rules.roster.benchSlots, 2); assert.equal(rules.roster.reserveSlots, 2); assert.equal(rules.roster.taxiSlots, 3);
  assert.deepEqual(rules.roster.eligiblePositions('SUPER_FLEX'), ['QB', 'RB', 'WR', 'TE']);
  assert.equal(rules.scoring.receptionFormat, 'ppr'); assert.deepEqual(rules.scoring.score({ pass_yd: 250, pass_td: 2 }), { points: 18, explanation: '250 pass_yd × 0.04 = 10.00; 2 pass_td × 4 = 8.00' });
  assert.equal(rules.playoffs.startsWeek, 15); assert.equal(rules.playoffs.matchupType, 'head-to-head-and-median'); assert.equal(rules.tradedDraftPicks, true);
});
