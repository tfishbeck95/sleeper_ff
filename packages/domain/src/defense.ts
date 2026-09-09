/**
 * Team defense / special teams (`DEF`) raw forecast contract.
 *
 * A provider supplies expected event counts and *probability distributions* over Sleeper's
 * points-allowed and yards-allowed tiers. It never supplies fantasy points, and it never asserts
 * that a threshold bonus was earned: a shutout is a probability, so `pts_allow_0` enters scoring as
 * P(shutout) and the league's own rate prices it. A favorable matchup therefore raises the expected
 * value of a bonus; it never grants the whole bonus.
 */

/** Sleeper's points-allowed tiers. `pts_allow_<bucket>` is the scoring key for each. */
export const POINTS_ALLOWED_BUCKETS = ['0', '1_6', '7_13', '14_20', '21_27', '28_34', '35p'] as const;
/** Sleeper's yards-allowed tiers. `yds_allow_<bucket>` is the scoring key for each. */
export const YARDS_ALLOWED_BUCKETS = ['0_100', '100_199', '200_299', '300_349', '350_399', '400_449', '450_499', '500_549', '550p'] as const;
export type PointsAllowedBucket = typeof POINTS_ALLOWED_BUCKETS[number];
export type YardsAllowedBucket = typeof YARDS_ALLOWED_BUCKETS[number];

/**
 * Inclusive bounds of each tier. A supplied mean is checked against its own distribution with these,
 * so a provider cannot pair a shutout-heavy distribution with a 27-point expectation. The open-ended
 * top tier has no upper bound, which suspends the upper check whenever it carries probability.
 */
export const POINTS_ALLOWED_BOUNDS: Readonly<Record<PointsAllowedBucket, readonly [number, number]>> = Object.freeze({
  '0': [0, 0], '1_6': [1, 6], '7_13': [7, 13], '14_20': [14, 20], '21_27': [21, 27], '28_34': [28, 34], '35p': [35, Infinity],
});
export const YARDS_ALLOWED_BOUNDS: Readonly<Record<YardsAllowedBucket, readonly [number, number]>> = Object.freeze({
  '0_100': [0, 99], '100_199': [100, 199], '200_299': [200, 299], '300_349': [300, 349], '350_399': [350, 399],
  '400_449': [400, 449], '450_499': [450, 499], '500_549': [500, 549], '550p': [550, Infinity],
});

/** A complete probability distribution over one tier set, optionally with its mean. */
export interface AllowedDistribution<Bucket extends string> {
  /** Probability of each tier. All tiers are explicit and the distribution sums to 1. */
  buckets: Record<Bucket, number>;
  /** Mean allowed. Required when the league scores per point or yard allowed; checked against `buckets`. */
  expected?: number;
}

/**
 * Raw expected counts for the unit. Every field is an independent Sleeper scoring event.
 *
 * `forcedFumbles` and `fumbleRecoveries` are deliberately separate and unconstrained by each other:
 * a defense can force a fumble the offense recovers, and can recover a fumble it never forced (an
 * aborted snap or a muffed exchange). Sleeper pays `ff` and `fum_rec` independently, and a forced
 * fumble the same defense recovers scores both. Neither count is ever derived from the other.
 */
export interface DefenseForecast {
  /** Team sacks. Sleeper's `sack`. */
  sacks: number;
  /** Interceptions by the defense. Sleeper's `int`, never the quarterback's `pass_int`. */
  interceptions: number;
  /** Fumbles forced by the defense. Sleeper's `ff`. */
  forcedFumbles: number;
  /** Opponent fumbles recovered by the defense. Sleeper's `fum_rec`. */
  fumbleRecoveries: number;
  safeties: number;
  blockedKicks: number;
  /** Defensive touchdowns only. Sleeper's `def_td`; return touchdowns belong in `specialTeams`. */
  defensiveTouchdowns: number;
  pointsAllowed: AllowedDistribution<PointsAllowedBucket>;
  yardsAllowed: AllowedDistribution<YardsAllowedBucket>;
  /**
   * The unit's special-teams events, where the league scores them. These are the team `def_st_*`
   * rules, not the individual `st_*` rules a rostered returner scores on their own line.
   */
  specialTeams?: { touchdowns: number; forcedFumbles: number; fumbleRecoveries: number };
  context?: DefenseContext;
}

export type OpponentQuarterbackStatus = 'confirmed-starter' | 'questionable' | 'backup' | 'rookie-starter' | 'unknown';

/** Matchup context behind the counts. Never converted to points; only ever a ranking preference. */
export interface DefenseContext {
  /** True when these effects already informed the counts and distributions; then no extra preference. */
  includedInForecast: boolean;
  /** Opponent exposure to pressure, as fractions of opponent dropbacks. */
  opponentPressure?: { sackRateAllowed: number; pressureRateAllowed: number };
  /** Opponent giveaway tendencies: interceptions per dropback and fumbles per offensive play. */
  opponentTurnovers?: { interceptionRate: number; fumbleRate: number };
  /** Opponent offensive-line availability. `startersOut` counts the five line positions. */
  opponentOffensiveLine?: { startersOut: number; continuity?: number };
  /** The opponent's starting quarterback for this game, as designated by the forecast source. */
  opponentQuarterback?: { status: OpponentQuarterbackStatus; name?: string };
  /** Adapter attests to licensed use; absent or unlicensed market inputs are never inferred. */
  game?: { source: string; licensed: true; impliedOpponentPoints: number; spread: number };
  /** Return volume this unit expects, and how weak the opponent has been in that phase. */
  specialTeams?: { returnOpportunities: number; opponentReturnYardsAllowed: number; opponentMuffRate?: number };
}

/** One raw category's contribution to the league-scored total. */
export interface DefenseComponent { label: string; stat: string; amount: number; rate: number; points: number }
/** One tier's probability-weighted contribution. `points` is `probability × rate`, never the whole bonus. */
export interface AllowedTier<Bucket extends string> { bucket: Bucket; stat: string; probability: number; rate: number; points: number }
export interface AllowedBreakdown<Bucket extends string> {
  tiers: Array<AllowedTier<Bucket>>;
  /** Mean allowed when the provider supplied one, else null. */
  expected: number | null;
  /** Sum of `probability × rate` across every tier this league scores. */
  expectedPoints: number;
  explanation: string;
}

export interface DefenseBreakdown {
  components: DefenseComponent[];
  pointsAllowed: AllowedBreakdown<PointsAllowedBucket> & { shutoutProbability: number };
  yardsAllowed: AllowedBreakdown<YardsAllowedBucket> & { under100Probability: number };
  /** Exhaustive group subtotals, each already part of `expectedPoints`. */
  pressurePoints: number; turnoverPoints: number; touchdownPoints: number;
  /** Safeties and blocked kicks: Sleeper scores both under team defense, not special teams. */
  situationalPoints: number;
  specialTeamsPoints: number; thresholdPoints: number; otherPoints: number;
  expectedPoints: number;
  /** Ordered largest first, so the majority of a total can be explained in one sentence. */
  drivers: Array<{ label: string; points: number; explanation: string }>;
  availabilityNote?: string;
  context: DefenseContext | null;
  explanation: string;
}

export interface DefenseStreamerProfile {
  forecast: DefenseBreakdown;
  /** A disclosed preference in ranking units, never added to projected fantasy points. */
  rankingAdjustment: number;
  factors: Array<{ label: string; value: number; explanation: string }>;
  missingContext: string[];
}
