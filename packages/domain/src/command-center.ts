import type { League, Roster, User, Matchup, Transaction, NflPlayer } from './index.js';
import type { ScoringConfiguration } from './scoring.js';
import type { LineupReport, LineupMatchup } from './projections.js';
import type { WaiverReport } from './waivers.js';
import type { TradeReport } from './trades.js';

export type SectionState = 'ready' | 'partial' | 'unavailable' | 'stale' | 'error';
export interface DashboardProvenance {
  scoringSnapshotId: string | null;
  forecastUpdatedAt: string | null;
}
export interface DashboardSection<T> {
  state: SectionState;
  data: T | null;
  warnings: string[];
  provenance: DashboardProvenance;
}
export interface StarterAlert {
  id: string; kind: 'inactive' | 'bye' | 'injury' | 'empty';
  playerId: string | null; slot: string; title: string; detail: string;
}
export interface DashboardLeagueSnapshot {
  league: League; roster: Roster; rosters: Roster[]; users: User[];
  matchups: Matchup[]; transactions: Transaction[]; players: NflPlayer[];
}
export interface SourceFreshness {
  source: string; updatedAt: string | null; state: SectionState;
}
export interface CommandCenterResponse {
  leagueId: string; rosterId: number; season: string; week: number; generatedAt: string;
  provenance: DashboardProvenance;
  sections: {
    snapshot: DashboardSection<DashboardLeagueSnapshot>;
    scoring: DashboardSection<ScoringConfiguration>;
    alerts: DashboardSection<StarterAlert[]>;
    lineup: DashboardSection<LineupReport>;
    matchup: DashboardSection<LineupMatchup>;
    waivers: DashboardSection<WaiverReport>;
    trades: DashboardSection<TradeReport>;
    freshness: DashboardSection<SourceFreshness[]>;
  };
}
