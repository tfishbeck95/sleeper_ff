import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, liveScoring, referenceScoring, scoringSnapshotId, scoringUnavailable } from '@sleeper/domain';
import { demoLineupInput } from './test-support/scoring-fixtures.js';
import { analyzeLineup } from './lineup.js';

const at = new Date('2026-09-08T12:00:00Z');
const fixture = () => demoLineupInput(at);

test('every lineup number is this league’s scoring applied to raw stats, with provenance and drivers', () => {
  const input = fixture();
  const report = analyzeLineup(input);
  assert.equal(report.status, 'ready');
  assert.equal(report.scoringSnapshotId, scoringSnapshotId(input.league.scoring!));
  assert.equal(report.scoringLabel, 'full-PPR');
  assert.equal(report.forecast!.updatedAt, input.signals!.updatedAt);
  assert.deepEqual(report.rejected, []);
  const cole = report.lineup.find(slot => slot.player?.name === 'Jordan Cole')!;
  assert.equal(cole.player!.scored.points, 12);
  assert.equal(cole.player!.scored.explanation, "12.0 points under your league's full-PPR scoring");
  assert.deepEqual(cole.player!.scored.contributions.map(c => [c.stat, c.points]), [['rec', 6], ['rec_yd', 6]]);
  assert.match(cole.explanation, /Jordan Cole fills WR with 12\.0 points under your league's full-PPR scoring/);
  // Floor and ceiling come from the provider's own low/high stat lines, scored the same way.
  assert.equal(cole.player!.floorPoints, 8.4); assert.equal(cole.player!.ceilingPoints, 16.2);
  for (const value of Object.values(report.replacementLevels)) assert.match(value.explanation, /under your league's full-PPR scoring/);
  assert.ok(report.rosterStrength.length);
  assert.match(report.methodology, /no generic projected-points value is accepted/);
});

test('start/sit compares the submitted lineup with the bench on league-scored points only', () => {
  const report = analyzeLineup(fixture());
  const bye = report.startSit.find(decision => decision.sit.name === 'Sam Ellis')!;
  assert.equal(bye.slot, 'TE'); assert.equal(bye.start.name, 'Owen Scott'); assert.equal(bye.advantage, 4);
  assert.match(bye.explanation, /Owen Scott scores 4\.0 points under your league's full-PPR scoring, 4 more than Sam Ellis's 0 in TE/);
  const injured = report.startSit.find(decision => decision.sit.name === 'Aaron Mills')!;
  assert.equal(injured.start.name, 'Evan Price');
  assert.ok(injured.cautions.length);
  // The optimal assignment is reported separately so the submitted lineup is never silently rewritten.
  assert.deepEqual(report.optimal.map(slot => slot.player?.name), ['Evan Price', 'Jordan Cole', 'Owen Scott']);
  assert.deepEqual(report.lineup.map(slot => slot.player?.name), ['Aaron Mills', 'Jordan Cole', 'Sam Ellis']);
  assert.ok(report.startSit.every((decision, index, all) => !index || all[index - 1].advantage >= decision.advantage));
});

test('matchup totals, win probability, bye and playoff outlooks all use the same league-scored points', () => {
  const report = analyzeLineup(fixture());
  assert.equal(report.matchup!.projectedFor.score, 12);
  assert.match(report.matchup!.projectedFor.explanation, /this league's full-PPR rules applied to each starter's raw stat forecast/);
  assert.equal(report.matchup!.margin.score, 12);
  assert.ok(report.matchup!.winProbability.value! > 50);
  assert.match(report.matchup!.winProbability.explanation, /10th-to-90th percentile/);
  const currentWeek = report.byeOutlook[0];
  assert.equal(currentWeek.week, 8); assert.deepEqual(currentWeek.startersOnBye, ['Sam Ellis']);
  assert.equal(currentWeek.fillableSlots, currentWeek.requiredSlots);
  assert.match(currentWeek.explanation, /under your league's full-PPR scoring/);
  assert.deepEqual(report.playoffOutlook!.weeks, [17]);
  assert.match(report.playoffOutlook!.explanation, /same raw-stat forecasts and rules as this week/);
});

test('a different league scoring rule set changes every downstream number', () => {
  const ppr = analyzeLineup(fixture());
  const half = fixture();
  half.league.scoring = liveScoring({ ...EXPECTED_SCORING, rec: .5 }, half.league.synchronizedAt);
  // A mismatched documented value fails validation, so nothing may be ranked at all.
  const blocked = analyzeLineup(half);
  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.warnings[0], /complete live scoring/);
  const custom = fixture();
  custom.league.scoring = liveScoring({ ...EXPECTED_SCORING, bonus_rec_wr: 2 }, custom.league.synchronizedAt);
  for (const player of custom.signals!.players) for (const week of player.weeks) week.stats.bonus_rec_wr = week.stats.rec ?? 0;
  const bonus = analyzeLineup(custom);
  assert.notEqual(bonus.scoringSnapshotId, ppr.scoringSnapshotId);
  assert.ok(bonus.matchup!.projectedFor.score > ppr.matchup!.projectedFor.score, 'a WR reception bonus must raise the league-scored total');
});

test('refused projections are named and excluded rather than counted as zero', () => {
  const input = fixture();
  input.signals!.players[1].weeks[0].stats = { targets: 9 };
  input.signals!.players.push({ playerId: 'not-a-player', weeks: input.signals!.players[0].weeks });
  const report = analyzeLineup(input);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.rejected.map(value => value.kind).sort(), ['identity', 'units']);
  assert.match(report.rejected.find(value => value.kind === 'units')!.message, /scoring rules do not define/);
  assert.ok(report.warnings.some(value => /refused and excluded rather than treated as authoritative/.test(value)));
  assert.ok(report.warnings.some(value => /Jordan Cole/.test(value)), 'the excluded starter is named, not silently zeroed');
  const cole = report.lineup.find(slot => slot.slot === 'WR')!;
  assert.equal(cole.player, null);
  assert.match(cole.explanation, /no validated, league-scored forecast/);
});

test('unavailable, partial or absent inputs produce an explicit unavailable report', () => {
  for (const scoring of [undefined, referenceScoring(), scoringUnavailable()]) {
    const input = fixture(); input.league.scoring = scoring;
    const report = analyzeLineup(input);
    assert.equal(report.status, 'unavailable');
    assert.deepEqual(report.startSit, []); assert.equal(report.matchup, null); assert.deepEqual(report.rosterStrength, []);
    assert.match(report.warnings[0], /complete live scoring/);
  }
  const noSource = fixture(); noSource.signals = null;
  assert.match(analyzeLineup(noSource).warnings[0], /no generic projection is substituted/);
  const stale = fixture(); stale.signals!.updatedAt = new Date(at.getTime() - 72 * 60 * 60_000).toISOString();
  assert.match(analyzeLineup(stale).warnings[0], /stale/);
});
