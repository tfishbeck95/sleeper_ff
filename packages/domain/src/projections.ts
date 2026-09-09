import type { ScoringConfiguration } from './scoring.js';

/**
 * The scored-projection contract.
 *
 * Forecast providers supply raw projected statistics only. Nothing downstream of this boundary may
 * consume a generic "projected points" number: fantasy points exist here solely because the selected
 * league's validated scoring rules were applied to raw stats, and every value carries the snapshot
 * that produced it, the statistics that produced it, and a sentence a manager can read.
 */

/** One statistic's contribution to a league-scored total. */
export interface ScoringContribution { stat: string; amount: number; rate: number; points: number }

/** Fantasy points that exist only because this league's rules were applied to raw statistics. */
export interface ScoredPoints {
  points: number;
  /** Manager-facing sentence, e.g. `18.4 points under your league's full-PPR scoring`. */
  explanation: string;
  /** Itemized arithmetic, e.g. `8 rec x 1 = 8.00; 124 rec_yd x 0.1 = 12.40`. */
  breakdown: string;
  /** Ordered by absolute contribution so the largest drivers can be disclosed on demand. */
  contributions: ScoringContribution[];
}

/** Why one provider projection was refused rather than silently treated as authoritative. */
export type ForecastRejectionKind = 'identity' | 'units' | 'pre-scored' | 'coverage' | 'scenario';
export interface ForecastRejection { playerId: string; kind: ForecastRejectionKind; message: string }

/** One league-scored week. `mean` is the pure scoring result; `points` adds the disclosed adjustments. */
export interface ScoredWeek {
  week: number; bye: boolean; opponent: string | null;
  mean: ScoredPoints; floor: ScoredPoints | null; ceiling: ScoredPoints | null;
  /** Combined matchup, role and availability factor applied after scoring; 1 means untouched. */
  multiplier: number; adjustments: string[];
  points: number; floorPoints: number | null; ceilingPoints: number | null;
}

export interface ScoredPlayerForecast {
  playerId: string; name: string; positions: string[]; team: string | null;
  injuryStatus: string | null; age: number | null;
  weeks: ScoredWeek[];
  /** Future typical week in the same league-scored units, when the provider supplies one. */
  dynasty: ScoredPoints | null;
  scoringSnapshotId: string; forecastUpdatedAt: string;
}

export interface ScoredForecastSet {
  scoringSnapshotId: string; scoringLabel: string; scoringSummary: string;
  forecastSource: string; forecastUpdatedAt: string; scoredAt: string;
  players: ScoredPlayerForecast[]; rejected: ForecastRejection[];
}

/** Every number surfaced by lineup analysis carries the reason it holds. */
export interface ExplainableScore { score: number; explanation: string }
export interface PositionEvaluation { position: string; starters: ExplainableScore; bench: ExplainableScore; scarcity: ExplainableScore }
export interface EvaluatedSlot { slot: string; playerId: string | null; name: string; points: number }
export interface RosterEvaluation {
  rosterId: number; rosterName: string;
  projectedWeekly: ExplainableScore; range: ExplainableScore;
  byeExposure: ExplainableScore; injuryExposure: ExplainableScore;
  benchUtilization: ExplainableScore; expendableDepth: ExplainableScore;
  dynastyAgeCurve: ExplainableScore | null; futurePickCapital: ExplainableScore | null;
  positions: PositionEvaluation[]; lineup: EvaluatedSlot[];
  floorPoints: number | null; ceilingPoints: number | null;
  relativeStrengths: string[]; relativeWeaknesses: string[];
}
export interface LeagueEvaluation {
  rosters: RosterEvaluation[]; replacementLevels: Record<string, ExplainableScore>;
  scoringSnapshotId: string; scoringLabel: string; forecastUpdatedAt: string;
}

export interface LineupPlayerView {
  playerId: string; name: string; positions: string[]; team: string | null;
  scored: ScoredPoints; floorPoints: number | null; ceilingPoints: number | null;
  bye: boolean; injuryStatus: string | null;
}
export interface StartSitDecision {
  id: string; slot: string; start: LineupPlayerView; sit: LineupPlayerView;
  advantage: number; explanation: string; confidence: 'high' | 'medium' | 'low'; cautions: string[];
}
export interface LineupMatchup {
  opponentRosterId: number | null; opponentName: string;
  projectedFor: ExplainableScore; projectedAgainst: ExplainableScore; margin: ExplainableScore;
  winProbability: { value: number | null; explanation: string };
}
export interface WeekOutlook {
  week: number; bye: boolean; playoff: boolean;
  startersOnBye: string[]; fillableSlots: number; requiredSlots: number;
  projected: number | null; explanation: string;
}
export interface LineupReport {
  leagueId: string; rosterId: number; week: number; season: string; generatedAt: string;
  status: 'ready' | 'partial' | 'unavailable';
  scoring: ScoringConfiguration; scoringSnapshotId: string; scoringLabel: string;
  forecast: { source: string; updatedAt: string } | null;
  warnings: string[]; rejected: ForecastRejection[];
  /** The lineup currently submitted in Sleeper, with each slot's league-scored points. */
  lineup: Array<{ slot: string; player: LineupPlayerView | null; explanation: string }>;
  /** The best legal assignment of the same active roster under the same league-scored points. */
  optimal: Array<{ slot: string; player: LineupPlayerView | null; explanation: string }>;
  bench: LineupPlayerView[];
  startSit: StartSitDecision[];
  matchup: LineupMatchup | null;
  rosterStrength: RosterEvaluation[];
  replacementLevels: Record<string, ExplainableScore>;
  byeOutlook: WeekOutlook[];
  playoffOutlook: { weeks: number[]; projected: number | null; explanation: string; risks: string[] } | null;
  methodology: string;
}
