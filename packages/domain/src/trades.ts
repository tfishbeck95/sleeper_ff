export type TradeStrategy = 'contender' | 'balanced' | 'rebuilder';
export interface TradeBounds {
  /** Absolute value difference divided by the larger package value. */
  maxValueGap: number;
  maxRisk: number;
  minNeedGain: number;
  /** Only dynasty rebuilders may sacrifice this fraction of projected points. */
  maxRebuilderLineupLoss: number;
  maxResults: number;
  maxAssetsPerTeam: number;
}
export interface TradeAsset {
  id: string; kind: 'player' | 'pick'; name: string; positions: string[];
  value: number; risk: number; explanation: string;
  age: number | null; careerYears: number | null;
  /**
   * How this player's raw stat forecast became points. Null for picks, which have no stat line.
   * Model units above are derived from `weeklyPoints`; they are never a provider's own total.
   */
  scoring: {
    snapshotId: string; label: string; weeklyPoints: number; explanation: string;
    contributions: import('./projections.js').ScoringContribution[];
  } | null;
}
export interface TradeLineup {
  legal: boolean; points: number;
  slots: Array<{ slot: string; playerId: string | null; name: string; points: number }>;
}
export interface TradeNeed {
  key: string; kind: 'starter' | 'depth' | 'longevity' | 'capital'; position: string | null;
  current: number; target: number; explanation: string;
}
export interface TradeTeamEvaluation {
  rosterId: number; name: string; strategy: TradeStrategy; strategyReason: string;
  needs: TradeNeed[]; surplus: TradeAsset[]; lineup: TradeLineup;
  futureCapital: { value: number; picks: TradeAsset[] } | null;
}
export interface TradeTeamImpact {
  rosterId: number; name: string; strategy: TradeStrategy;
  before: TradeLineup; after: TradeLineup;
  valueDelivered: number; valueReceived: number;
  needImprovements: Array<{ need: TradeNeed; after: number; gain: number }>;
}
export interface TradeOffer {
  id: string; give: TradeAsset[]; receive: TradeAsset[];
  user: TradeTeamImpact; partner: TradeTeamImpact;
  valueGap: number; risk: number; whyAccept: string[]; risks: string[];
}
export interface TradeCandidate extends TradeOffer {
  fallback: TradeOffer | null; fallbackReason: string;
}
export interface TradeReport {
  scoring?: import('./scoring.js').ScoringConfiguration;
  scoringSnapshotId: string; scoringLabel: string; forecastUpdatedAt: string | null;
  rejected: import('./projections.js').ForecastRejection[];
  leagueId: string; rosterId: number; week: number; format: 'redraft' | 'dynasty' | 'keeper';
  status: 'ready' | 'partial' | 'unavailable';
  source: { name: string; updatedAt: string } | null;
  bounds: TradeBounds; warnings: string[]; teams: TradeTeamEvaluation[];
  candidates: TradeCandidate[]; methodology: string;
}
