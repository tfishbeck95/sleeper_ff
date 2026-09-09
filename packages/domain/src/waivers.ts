/** Shared wire contract. Forecasts are supplied by a separately configured data source. */
export type WaiverHorizon = 'streamer' | 'rest-of-season' | 'dynasty';
export type WaiverRisk = 'low' | 'medium' | 'high';
export type WaiverNeed = 'starter-upgrade' | 'bye-cover' | 'injury-cover' | 'bench-depth' | 'stash';
export interface WaiverPlayer { id: string; name: string; positions: string[]; team: string | null }
export interface WaiverRecommendation {
  id: string; priority: number; add: WaiverPlayer; drop: WaiverPlayer | null;
  horizon: WaiverHorizon; risk: WaiverRisk; need: WaiverNeed; score: number;
  /** League-scored points. `pointsExplanation` names the scoring; `contributions` itemizes it. */
  projectedPoints: number;
  pointsExplanation: string;
  contributions: import('./projections.js').ScoringContribution[];
  /** Receiving role behind the projection: workload, archetype, stability and the PPR premium. */
  opportunity: import('./projections.js').OpportunityProfile | null;
  starterGain: number | null; benchGain: number | null;
  starterComparison: WaiverPlayer | null; weakestBench: WaiverPlayer | null;
  dropCost: number | null; dropReason: string;
  upcoming: Array<{ week: number; opponent: string | null; bye: boolean; points: number | null }>;
  playoffPoints: number | null;
  reasons: string[]; uncertainty: string[];
  faab: { min: number; max: number; remaining: number; urgency: 'low' | 'medium' | 'high'; explanation: string } | null;
}
export interface WaiverReport {
  scoring?: import('./scoring.js').ScoringConfiguration;
  /** Provenance of every point below: which scoring observation scored which forecast, and when. */
  scoringSnapshotId: string; scoringLabel: string; forecastUpdatedAt: string | null;
  rejected: import('./projections.js').ForecastRejection[];
  leagueId: string; rosterId: number; week: number; season: string; generatedAt: string;
  rosterSyncedAt: string; source: { name: string; updatedAt: string } | null;
  status: 'ready' | 'partial' | 'unavailable'; warnings: string[];
  rosteredCount: number; eligibleCount: number; evaluatedCount: number;
  recommendations: WaiverRecommendation[];
  submission: { supported: false; url: string | null; instruction: string };
}
