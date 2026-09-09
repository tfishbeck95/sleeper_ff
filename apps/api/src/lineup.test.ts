import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, liveScoring, referenceScoring, scoringSnapshotId, scoringUnavailable } from '@sleeper/domain';
import { demoLineupInput } from './test-support/scoring-fixtures.js';
import { analyzeLineup } from './lineup.js';

const at = new Date('2026-09-08T12:00:00Z');
const fixture = () => demoLineupInput(at);
const signal = (input: ReturnType<typeof fixture>, id: string) => input.signals!.players.find(p => p.playerId === id)!;

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
  // Floor and ceiling come from the provider's own low/high stat lines, scored the same way. The
  // floor is then lifted toward the mean, bounded, for his steady target share; the others are not.
  assert.equal(cole.player!.ceilingPoints, 16.2);
  assert.equal(cole.player!.floorPoints, 9.2, 'the 8.4 scored floor is lifted 21.1% of the way to the 12-point mean');
  assert.equal(cole.player!.scored.points, 12, 'the mean is never touched by a role signal');
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
  // A healthy player's "Active" roster status is not an availability designation to warn about.
  assert.ok(report.startSit.every(decision => !decision.cautions.some(caution => /designation "Active"/.test(caution))));
  assert.equal(injured.confidence, 'high');
  assert.equal(injured.start.injuryStatus, null);
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

test('a consistently targeted player gets a bounded floor lift; the mean and ceiling never move', () => {
  const plain = fixture();
  for (const player of plain.signals!.players) delete player.recentTargets;
  const bare = analyzeLineup(plain).lineup.find(slot => slot.player?.name === 'Jordan Cole')!.player!;
  const lifted = analyzeLineup(fixture()).lineup.find(slot => slot.player?.name === 'Jordan Cole')!.player!;
  assert.equal(bare.floorPoints, 8.4, 'without an observed target series the supplied floor stands as scored');
  assert.ok(lifted.floorPoints! > bare.floorPoints!);
  assert.ok(lifted.floorPoints! < lifted.scored.points, 'a lifted floor never reaches, let alone passes, the mean');
  assert.equal(lifted.scored.points, bare.scored.points, 'the mean is identical');
  assert.equal(lifted.ceilingPoints, bare.ceilingPoints, 'the ceiling is identical');
  assert.match(lifted.opportunity!.explanation, /lifts the supplied floor 21% of the way toward the mean; the mean and ceiling are untouched/);
});

test('a safe lineup decision prefers the steadier target share and says so', () => {
  const input = fixture();
  // Two bench tight ends worth the same league-scored points; only their target series differ.
  const erratic = signal(input, 'bench-3');
  erratic.recentTargets = [1, 11, 2, 10, 2, 9];
  const report = analyzeLineup(input);
  const decision = report.startSit.find(value => value.slot === 'TE')!;
  assert.equal(decision.start.name, 'Owen Scott');
  assert.ok(decision.start.opportunity!.stability! < .5);
  assert.match(decision.explanation, /Owen Scott has a 0\.\d+ target-stability score on [\d.]+ projected targets/);
  // Swapping toward the less consistent role is allowed, but never silently.
  const steadier = fixture();
  signal(steadier, 'starter-te').recentTargets = [9, 9, 9, 9, 9, 9];
  signal(steadier, 'bench-3').recentTargets = [0, 9, 1, 8, 0, 7];
  const warned = analyzeLineup(steadier).startSit.find(value => value.slot === 'TE')!;
  assert.ok(warned.cautions.some(caution => /has the less stable target share/.test(caution)));
  assert.equal(warned.confidence, 'low', 'a warned swap is not a high-confidence one');
});
