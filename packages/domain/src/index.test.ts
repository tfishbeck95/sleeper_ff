import { EXPECTED_SCORING, liveScoring } from './index.js';
const scoring = liveScoring({ ...EXPECTED_SCORING }, '2026-09-08T12:00:00Z');
import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretLeagueRules, scoringSnapshotId } from './index.js';
test('interprets Sleeper roster, dynasty, playoff, and custom scoring settings', () => {
  const rules = interpretLeagueRules({
    scoring, previousLeagueId: 'old', seasonType: 'regular',
    scoringSettings: [{ key: 'rec', points: 1 }, { key: 'pass_yd', points: .04 }, { key: 'pass_td', points: 6 }],
    rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'SUPER_FLEX', 'BN', 'BN'].map((position, slot) => ({ position, slot })),
    settings: { type: 2, reserve_slots: 2, taxi_slots: 3, playoff_teams: 6, playoff_week_start: 15, league_average_match: 1 },
  });
  assert.equal(rules.format, 'dynasty'); assert.equal(rules.roster.benchSlots, 2); assert.equal(rules.roster.reserveSlots, 2); assert.equal(rules.roster.taxiSlots, 3);
  assert.deepEqual(rules.roster.eligiblePositions('SUPER_FLEX'), ['QB', 'RB', 'WR', 'TE']);
  assert.equal(rules.scoring.receptionFormat, 'ppr');
  const scored = rules.scoring.score({ pass_yd: 250, pass_td: 2 });
  assert.equal(scored.points, 18);
  assert.equal(scored.breakdown, '250 pass_yd × 0.04 = 10.00; 2 pass_td × 4 = 8.00');
  assert.equal(scored.explanation, "18.0 points under your league's full-PPR scoring");
  assert.deepEqual(scored.contributions.map(c => c.stat), ['pass_yd', 'pass_td']);
  assert.equal(rules.scoring.snapshotId, scoringSnapshotId(scoring));
  assert.equal(rules.playoffs.startsWeek, 15); assert.equal(rules.playoffs.matchupType, 'head-to-head-and-median'); assert.equal(rules.tradedDraftPicks, true);
});
test('a scoring snapshot id is stable, key-order independent and changes with the rules or observation', () => {
  const shuffled = liveScoring(Object.fromEntries(Object.entries(EXPECTED_SCORING).reverse()), '2026-09-08T12:00:00Z');
  assert.equal(scoringSnapshotId(shuffled), scoringSnapshotId(scoring));
  assert.notEqual(scoringSnapshotId(liveScoring({ ...EXPECTED_SCORING }, '2026-09-08T13:00:00Z')), scoringSnapshotId(scoring));
  assert.notEqual(scoringSnapshotId(liveScoring({ ...EXPECTED_SCORING, rec: .5 }, '2026-09-08T12:00:00Z')), scoringSnapshotId(scoring));
  assert.match(scoringSnapshotId(scoring), /^complete-live:2026-09-08T12:00:00Z:[0-9a-f]{8}$/);
});
