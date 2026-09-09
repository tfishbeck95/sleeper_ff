import type { OpportunityProfile, ReceptionArchetype, ScoredPoints, WeekOpportunity } from '@sleeper/domain';
import type { PlayerSignal, WeeklyForecast } from './waiver-signals.js';

/**
 * Receiving-opportunity derivation.
 *
 * Everything here is a deterministic function of statistics the provider supplied and points the
 * league's own rules already produced. No module in this file converts a workload measure into
 * fantasy points: reception points are read back out of the scored contributions, so a reception is
 * scored exactly once, by the league, and never receives a second bonus for being a reception.
 */

/** Documented, bounded thresholds. Explicit heuristics, not calibrated models. */
export const OPPORTUNITY_THRESHOLDS = Object.freeze({
  /** A back at or above either of these is treated as a pass-catching back. */
  backRouteParticipation: .5, backTargetShare: .12, backTargets: 3.5,
  /** Reception + receiving-yardage share at or above this, with touchdowns below, reads as volume. */
  volumeShare: .6, volumeTouchdownCeiling: .3,
  /** Touchdown points at or above this share of the total read as touchdown dependence. */
  touchdownDependence: .4,
  /** Reception points at or above this share make the league's reception rule decisive for value. */
  receptionDecisive: .25,
  /** The most a stability signal may lift a supplied floor toward its mean. */
  maxFloorLift: .25,
  /** Stability below this earns no lift; the lift scales linearly from here to 1. */
  floorLiftStabilityFloor: .5,
});

const RECEPTION_STATS = ['rec'];
const RECEIVING_YARDAGE_STATS = ['rec_yd', 'rec_fd', 'bonus_rec_yd_100', 'bonus_rec_yd_200'];
const TOUCHDOWN_STATS = ['rec_td', 'rush_td', 'pass_td', 'fum_rec_td', 'def_st_td', 'st_td', 'def_td'];
const round = (value: number, places = 2) => { const factor = 10 ** places; return Math.round(value * factor) / factor; };
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => values.length ? sum(values) / values.length : 0;

/** Points a family of statistics contributed, read back from the league's own scoring. */
const pointsFrom = (scored: ScoredPoints, stats: readonly string[]) =>
  sum(scored.contributions.filter(value => stats.includes(value.stat)).map(value => value.points));

export function weekOpportunity(forecast: WeeklyForecast): WeekOpportunity | null {
  const supplied = forecast.opportunity;
  if (!supplied) return null;
  const perRoute = supplied.targetsPerRouteRun ?? (supplied.routes && supplied.routes > 0 ? supplied.targets / supplied.routes : null);
  return {
    targets: supplied.targets,
    routes: supplied.routes ?? null,
    targetsPerRouteRun: perRoute == null ? null : round(perRoute, 3),
    routeParticipation: supplied.routeParticipation ?? null,
    targetShare: supplied.targetShare ?? null,
    redZoneTargets: supplied.redZoneTargets ?? null,
  };
}

/**
 * Weekly target stability from the observed recent target series: `1 - coefficient of variation`,
 * clamped to 0-1. A back-to-back 8/8/8 line scores 1; a 1/14/2 line scores near 0. Fewer than three
 * observed games is not enough evidence and yields null rather than a flattering default.
 */
export function targetStability(recentTargets: readonly number[] | undefined): number | null {
  if (!recentTargets || recentTargets.length < 3) return null;
  const average = mean([...recentTargets]);
  if (average <= 0) return 0;
  const deviation = Math.sqrt(mean(recentTargets.map(value => (value - average) ** 2)));
  return round(Math.max(0, Math.min(1, 1 - deviation / average)), 3);
}

/** Targets per game in the most recent third of the series minus the earlier games. */
export function targetTrend(recentTargets: readonly number[] | undefined): number | null {
  if (!recentTargets || recentTargets.length < 4) return null;
  const split = Math.max(1, Math.round(recentTargets.length / 3));
  const recent = recentTargets.slice(-split), prior = recentTargets.slice(0, -split);
  return prior.length ? round(mean([...recent]) - mean([...prior])) : null;
}

export interface ProfileInput {
  positions: readonly string[];
  signal: PlayerSignal;
  /** The league-scored mean for the week being explained. */
  scored: ScoredPoints;
  weeks: readonly WeekOpportunity[];
  /** This league's points per reception, so an explanation can name what is actually at stake. */
  receptionPoints: number | null;
  scoringLabel: string;
}

/** Builds the profile every recommendation surface uses to explain and rank receiving roles. */
export function opportunityProfile(input: ProfileInput): OpportunityProfile | null {
  const { positions, signal, scored, weeks } = input;
  const covered = weeks.filter(week => week.targets != null);
  const stability = targetStability(signal.recentTargets);
  const trend = targetTrend(signal.recentTargets);
  const total = scored.points;
  const receptionScore = pointsFrom(scored, RECEPTION_STATS);
  const yardageScore = pointsFrom(scored, RECEIVING_YARDAGE_STATS);
  const touchdownScore = pointsFrom(scored, TOUCHDOWN_STATS);
  // Nothing to say when the provider supplied no opportunity and the league scored no receiving.
  if (!covered.length && stability == null && receptionScore === 0) return null;
  const share = (value: number) => total > 0 ? round(value / total, 3) : null;
  const receptionShare = share(receptionScore);
  const touchdownShare = share(touchdownScore);
  const volumeShare = share(receptionScore + yardageScore);
  const targets = covered.length ? round(mean(covered.map(week => week.targets!))) : null;
  const perRoute = covered.filter(week => week.targetsPerRouteRun != null);
  const participation = covered.filter(week => week.routeParticipation != null);
  const targetShare = covered.filter(week => week.targetShare != null);
  const redZone = covered.filter(week => week.redZoneTargets != null);
  const back = positions.includes('RB');
  const passCatchingBack = back && (
    (participation.length > 0 && mean(participation.map(week => week.routeParticipation!)) >= OPPORTUNITY_THRESHOLDS.backRouteParticipation)
    || (targetShare.length > 0 && mean(targetShare.map(week => week.targetShare!)) >= OPPORTUNITY_THRESHOLDS.backTargetShare)
    || (targets != null && targets >= OPPORTUNITY_THRESHOLDS.backTargets));
  const archetype: ReceptionArchetype = receptionScore === 0 && yardageScore === 0 ? 'non-receiving'
    : touchdownShare != null && touchdownShare >= OPPORTUNITY_THRESHOLDS.touchdownDependence ? 'touchdown-dependent'
      : volumeShare != null && volumeShare >= OPPORTUNITY_THRESHOLDS.volumeShare && (touchdownShare ?? 0) < OPPORTUNITY_THRESHOLDS.volumeTouchdownCeiling ? 'volume-driven'
        : 'balanced';
  const profile: OpportunityProfile = {
    targets,
    targetsPerRouteRun: perRoute.length ? round(mean(perRoute.map(week => week.targetsPerRouteRun!)), 3) : null,
    routeParticipation: participation.length ? round(mean(participation.map(week => week.routeParticipation!)), 3) : null,
    targetShare: targetShare.length ? round(mean(targetShare.map(week => week.targetShare!)), 3) : null,
    redZoneTargets: redZone.length ? round(mean(redZone.map(week => week.redZoneTargets!))) : null,
    receptionPoints: round(receptionScore), receptionShare, touchdownShare,
    archetype, passCatchingBack, stability, trend,
    floorLift: floorLift(stability, receptionShare),
    explanation: '', receptionExplanation: '',
  };
  profile.explanation = describe(profile, input);
  profile.receptionExplanation = describeReceptionValue(profile, input);
  return profile;
}

/**
 * A bounded, deterministic lift of a *supplied* floor scenario toward its mean for consistently
 * targeted players. It never touches the mean or the ceiling, never invents a floor where the
 * provider supplied none, and never adds points for a reception: it only narrows the downside a
 * stable target share has already earned. Zero unless receptions matter to this player's scoring.
 */
export function floorLift(stability: number | null, receptionShare: number | null): number {
  if (stability == null || receptionShare == null || receptionShare < OPPORTUNITY_THRESHOLDS.receptionDecisive) return 0;
  const { floorLiftStabilityFloor: base, maxFloorLift: cap } = OPPORTUNITY_THRESHOLDS;
  if (stability <= base) return 0;
  // Quantized to whole percentage points: a lift too small to state honestly is no lift at all.
  const lift = round((stability - base) / (1 - base) * cap, 2);
  return lift < .01 ? 0 : lift;
}

function describe(profile: OpportunityProfile, input: ProfileInput): string {
  const parts: string[] = [];
  if (profile.targets != null) parts.push(`${profile.targets} projected targets per week${profile.targetsPerRouteRun != null ? ` on ${profile.targetsPerRouteRun} targets per route run` : ''}`);
  if (profile.routeParticipation != null) parts.push(`${Math.round(profile.routeParticipation * 100)}% route participation`);
  if (profile.targetShare != null) parts.push(`${Math.round(profile.targetShare * 100)}% of team targets`);
  if (profile.redZoneTargets != null) parts.push(`${profile.redZoneTargets} red-zone targets`);
  if (profile.stability != null) parts.push(`target stability ${profile.stability} over ${input.signal.recentTargets!.length} observed games`);
  if (profile.trend != null && profile.trend !== 0) parts.push(`${profile.trend > 0 ? '+' : ''}${profile.trend} targets per game versus his earlier games`);
  const archetype = profile.archetype === 'volume-driven' ? 'Volume-driven: receptions and receiving yardage carry the projection, so week-to-week scoring is less touchdown-dependent.'
    : profile.archetype === 'touchdown-dependent' ? `Touchdown-dependent: ${Math.round((profile.touchdownShare ?? 0) * 100)}% of the league-scored total comes from touchdowns, which are the least stable part of any projection.`
      : profile.archetype === 'non-receiving' ? 'No receiving production is projected, so reception scoring does not affect this value.'
        : 'Balanced: neither reception volume nor touchdowns dominate the league-scored total.';
  return `${parts.length ? `${parts.join('; ')}. ` : ''}${archetype}${profile.floorLift > 0 ? ` A consistent target share lifts the supplied floor ${Math.round(profile.floorLift * 100)}% of the way toward the mean; the mean and ceiling are untouched.` : ''}`;
}

function describeReceptionValue(profile: OpportunityProfile, input: ProfileInput): string {
  const { receptionPoints, scoringLabel } = input;
  if (!receptionPoints) return `This league scores ${receptionPoints === 0 ? 'nothing' : 'no known value'} per reception, so reception volume changes nothing about this value.`;
  if (profile.receptionPoints <= 0) return `No receptions are projected, so your league's ${scoringLabel} scoring does not lift this value.`;
  const withoutReceptions = round(input.scored.points - profile.receptionPoints);
  const decisive = (profile.receptionShare ?? 0) >= OPPORTUNITY_THRESHOLDS.receptionDecisive;
  return `${profile.receptionPoints} of ${round(input.scored.points)} points come from receptions at ${receptionPoints} per catch: ${Math.round((profile.receptionShare ?? 0) * 100)}% of the total. Under non-PPR scoring the same stat line projects ${withoutReceptions}.${decisive ? ` Your league's ${scoringLabel} scoring is specifically what elevates this value${profile.passCatchingBack ? ', and standard-scoring running-back rankings understate it' : ''}.` : ''}`;
}
