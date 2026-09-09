import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, interpretScoring, liveScoring } from '@sleeper/domain';
import { floorLift, OPPORTUNITY_THRESHOLDS, opportunityProfile, targetStability, targetTrend, weekOpportunity } from './opportunity.js';
import type { PlayerSignal, WeeklyForecast } from './waiver-signals.js';

const rules = interpretScoring([], liveScoring({ ...EXPECTED_SCORING }, '2026-09-08T12:00:00Z'));
const profileFor = (positions: string[], stats: Record<string, number>, signal: Partial<PlayerSignal> = {}, weeks: WeeklyForecast[] = []) => opportunityProfile({
  positions, signal: { playerId: 'p', weeks: [], ...signal }, scored: rules.score(stats),
  weeks: weeks.map(weekOpportunity).filter((v): v is NonNullable<typeof v> => Boolean(v)),
  receptionPoints: rules.receptionPoints, scoringLabel: rules.label,
});
const week = (opportunity: WeeklyForecast['opportunity']): WeeklyForecast => ({ week: 8, bye: false, stats: { rec: 1 }, opportunity });

test('targets per route run is derived when the rate is not supplied, and preserved when it is', () => {
  assert.equal(weekOpportunity(week({ targets: 8, routes: 32 }))!.targetsPerRouteRun, .25);
  assert.equal(weekOpportunity(week({ targets: 8, routes: 32, targetsPerRouteRun: .3 }))!.targetsPerRouteRun, .3);
  assert.equal(weekOpportunity(week({ targets: 8 }))!.targetsPerRouteRun, null, 'no equivalent measure is invented');
  assert.equal(weekOpportunity({ week: 8, bye: false, stats: { rec: 1 } }), null);
});

test('stability and trend come from the observed series, and stay null without enough evidence', () => {
  assert.equal(targetStability([8, 8, 8, 8]), 1);
  assert.ok(targetStability([9, 8, 10, 9, 9, 8])! > .9);
  assert.ok(targetStability([1, 12, 2, 11, 3, 9])! < .4);
  assert.equal(targetStability([0, 0, 0]), 0);
  assert.equal(targetStability([8, 9]), null, 'two games is not evidence of a stable role');
  assert.equal(targetStability(undefined), null);
  assert.equal(targetTrend([2, 3, 4, 7, 9, 10]), 5.5, 'the recent third (9, 10) averages 5.5 more than the earlier four games');
  assert.equal(targetTrend([8, 8, 8]), null);
});

test('reception share is read back out of the league-scored total, never added to it', () => {
  const profile = profileFor(['WR'], { rec: 8, rec_yd: 100, rec_td: 1 }, {}, [week({ targets: 11 })])!;
  // 8 rec + 10 rec_yd + 6 rec_td = 24 points; receptions are 8 of them.
  assert.equal(profile.receptionPoints, 8);
  assert.equal(profile.receptionShare, .333);
  assert.equal(profile.touchdownShare, .25);
  assert.match(profile.receptionExplanation, /8 of 24 points come from receptions at 1 per catch: 33% of the total/);
  assert.match(profile.receptionExplanation, /Under non-PPR scoring the same stat line projects 16/);
  assert.match(profile.receptionExplanation, /specifically what elevates this value/);
});

test('volume-driven and touchdown-dependent receivers are distinguished by where the points come from', () => {
  const volume = profileFor(['WR'], { rec: 8, rec_yd: 90 }, {}, [week({ targets: 11 })])!;
  assert.equal(volume.archetype, 'volume-driven');
  assert.match(volume.explanation, /Volume-driven/);
  const touchdowns = profileFor(['WR'], { rec: 2, rec_yd: 30, rec_td: 1 }, {}, [week({ targets: 4 })])!;
  assert.equal(touchdowns.archetype, 'touchdown-dependent');
  assert.match(touchdowns.explanation, /least stable part of any projection/);
  assert.equal(profileFor(['RB'], { rush_yd: 90, rush_td: 1 }, {}, [week({ targets: 1 })])!.archetype, 'non-receiving');
  assert.equal(profileFor(['RB'], { rush_yd: 90 })!, null, 'no opportunity and no receiving means nothing to say');
});

test('a pass-catching back is identified by route load, target share or target volume', () => {
  const byRoutes = profileFor(['RB'], { rush_yd: 40, rec: 4, rec_yd: 30 }, {}, [week({ targets: 2, routeParticipation: .62 })])!;
  assert.equal(byRoutes.passCatchingBack, true);
  assert.match(byRoutes.receptionExplanation, /standard-scoring running-back rankings understate it/);
  assert.equal(profileFor(['RB'], { rush_yd: 40, rec: 4 }, {}, [week({ targets: 2, targetShare: .14 })])!.passCatchingBack, true);
  assert.equal(profileFor(['RB'], { rush_yd: 40, rec: 4 }, {}, [week({ targets: 5 })])!.passCatchingBack, true);
  assert.equal(profileFor(['RB'], { rush_yd: 90, rec: 1 }, {}, [week({ targets: 1, routeParticipation: .15 })])!.passCatchingBack, false);
  assert.equal(profileFor(['WR'], { rec: 8, rec_yd: 90 }, {}, [week({ targets: 11, routeParticipation: .9 })])!.passCatchingBack, false, 'only backs qualify');
});

test('the floor lift is bounded, needs consistency and reception relevance, and never touches the mean', () => {
  assert.equal(floorLift(1, .5), OPPORTUNITY_THRESHOLDS.maxFloorLift, 'a perfectly stable target share earns the cap');
  assert.equal(floorLift(.5, .5), 0, 'stability at the threshold earns nothing');
  assert.equal(floorLift(.2, .9), 0, 'an erratic target share is never rewarded');
  assert.equal(floorLift(1, .1), 0, 'receptions must actually matter to this player');
  assert.equal(floorLift(null, .5), 0, 'no observed series, no lift');
  for (const stability of [.6, .75, .9, 1]) assert.ok(floorLift(stability, .5) <= OPPORTUNITY_THRESHOLDS.maxFloorLift);
  const steady = profileFor(['WR'], { rec: 8, rec_yd: 90 }, { recentTargets: [9, 8, 10, 9, 9, 8] }, [week({ targets: 9 })])!;
  assert.ok(steady.floorLift > 0);
  assert.match(steady.explanation, /lifts the supplied floor \d+% of the way toward the mean; the mean and ceiling are untouched/);
});

test('a league that does not score receptions gets no reception premium in its explanations', () => {
  const standard = interpretScoring([], liveScoring({ ...EXPECTED_SCORING, rec: 0 }, '2026-09-08T12:00:00Z'));
  assert.equal(standard.actionable, false, 'a documented-value mismatch is not scorable at all');
  const custom = interpretScoring([], { kind: 'complete-live', settings: { ...EXPECTED_SCORING, rec: 0 }, rawSettings: null, synchronizedAt: '2026-09-08T12:00:00Z', issues: [] });
  const profile = opportunityProfile({
    positions: ['WR'], signal: { playerId: 'p', weeks: [] }, scored: custom.score({ rec: 8, rec_yd: 90 }),
    weeks: [weekOpportunity(week({ targets: 11 }))!], receptionPoints: custom.receptionPoints, scoringLabel: custom.label,
  })!;
  assert.equal(profile.receptionPoints, 0);
  assert.equal(profile.floorLift, 0);
  assert.match(profile.receptionExplanation, /scores nothing per reception, so reception volume changes nothing/);
});

test('a lift too small to state honestly is no lift at all', () => {
  // Stability barely over the threshold rounds to 0%, so no adjustment is claimed or applied.
  assert.equal(floorLift(.503, .5), 0);
  assert.equal(floorLift(.51, .5), .01, 'the smallest lift that can be stated is one percent');
  const marginal = profileFor(['WR'], { rec: 7, rec_yd: 70 }, { recentTargets: [2, 3, 4, 12, 14, 15] }, [week({ targets: 10 })])!;
  assert.equal(marginal.floorLift, 0);
  assert.doesNotMatch(marginal.explanation, /lifts the supplied floor/);
});
