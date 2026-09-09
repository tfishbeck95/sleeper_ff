export const KICKER_DISTANCE_BANDS = ['0_19', '20_29', '30_39', '40_49', '50_59', '60p'] as const;
export type KickerDistanceBand = typeof KICKER_DISTANCE_BANDS[number];

/** Raw expected counts, including blocked kicks as misses. No fantasy points or consensus ranks. */
export interface KickerForecast {
  fieldGoals: Record<KickerDistanceBand, { attempts: number; makes: number }>;
  pat: { makes: number; misses: number };
  misses: {
    semantics: 'all-attempts-including-blocks';
    /** Supply total, all six distance categories, or both; overlapping counts are reconciled. */
    total?: number;
    byDistance?: Record<KickerDistanceBand, number>;
  };
  /** Probability of at least one attempt from 50+ yards, not the share of attempts. */
  longAttemptProbability: number;
  context?: KickerContext;
}

export interface KickerContext {
  /** True when these effects already informed attempts/makes; then no extra context preference. */
  includedInForecast: boolean;
  offense?: { drivesPerGame: number; scoringDriveRate: number };
  opponent?: { redZoneTouchdownRate: number };
  stadium?: { name: string; roof: 'indoor' | 'outdoor' | 'retractable-open' | 'retractable-closed' };
  weather?: { windMph: number; precipitationProbability: number; temperatureF: number };
  /** Adapter attests to licensed use; absent or unlicensed market inputs are never inferred. */
  game?: { source: string; licensed: true; impliedTeamPoints: number; spread: number };
}

export interface KickerBreakdown {
  distances: Array<{ band: KickerDistanceBand; attempts: number; makes: number; misses: number; makePoints: number; missPoints: number }>;
  expectedAttempts: number; expectedMakes: number; expectedMisses: number;
  longAttemptProbability: number; accuracy: number | null;
  patMakes: number; patMisses: number; patPoints: number;
  fieldGoalMissPoints: number; patMissPoints: number;
  /** Positive magnitude of negative miss contributions, already deducted from expectedPoints. */
  missDownside: number;
  expectedPoints: number;
  availabilityNote?: string;
  context: KickerContext | null;
  explanation: string;
}
export interface KickerStreamerProfile {
  forecast: KickerBreakdown;
  /** A disclosed preference in ranking units, never added to projected fantasy points. */
  rankingAdjustment: number;
  factors: Array<{ label: string; value: number; explanation: string }>;
  missingContext: string[];
}
