import type { ScoringConfiguration } from '@sleeper/domain';
import type { SleeperLeague, SleeperRoster, SleeperUser, SleeperLeagueUser, SleeperMatchup, SleeperTransaction, SleeperPlayer } from '@sleeper/sleeper-client';

export interface ConnectedLeague { league: SleeperLeague; roster?: SleeperRoster; coOwned: boolean; error?: string }
export interface DashboardConnection { user: SleeperUser; leagues: ConnectedLeague[] }
export type AlertKind = 'inactive' | 'bye' | 'injury' | 'empty' | 'sync';
/**
 * Illustrative demo view models only. `illustrativePoints` is never produced by a league's scoring
 * rules, so it is deliberately not named like a projection and never reaches ranking: connected
 * leagues get league-scored analysis from `LineupReport`, `WaiverReport` and `TradeReport` instead.
 */
export interface DashboardPlayer { id: string; name: string; position: string; team: string; illustrativePoints?: number }
export interface ProposedAction {
  id: string; kind: 'start' | 'waiver' | 'trade' | 'sync'; title: string; reason: string;
  checklist: string[]; confidence?: number; caution?: string;
}
export interface StartDecision extends ProposedAction { start?: DashboardPlayer; sit?: DashboardPlayer; slot?: string; advantage?: number }
export interface WaiverTarget extends ProposedAction { player?: DashboardPlayer; drop?: DashboardPlayer; fit?: number; fitLabel: string; advantage?: number }
export interface DashboardAlert { id: string; kind: AlertKind; title: string; detail: string; action: ProposedAction }
export interface DashboardData {
  scoring?: ScoringConfiguration;
  /** `starts`, `waivers`, `trades` and matchup projections are populated only in the demo scenario. */
  demo: boolean; week: number; teamName: string; format: string; lastSyncedAt: string | null; coverageNote?: string;
  alerts: DashboardAlert[]; starts: StartDecision[]; waivers: WaiverTarget[]; trades: ProposedAction[];
  needs: Array<{ position: string; status: string; tone: 'warning' | 'good' }>;
  /** `illustrative*` and `winChance` are set only by the demo scenario. A connected league's
   *  league-scored matchup totals and win probability come from `LineupReport`, never from here. */
  matchup: { opponent: string; illustrativeFor?: number; illustrativeAgainst?: number; actualFor?: number; actualAgainst?: number; winChance?: number; paths: string[]; risks: string[] } | null;
  standings: Array<{ id: string; name: string; wins: number; losses: number; ties: number; points: number; isUser: boolean }>;
  activity: Array<{ id: string; type: string; title: string; detail: string; time: string }>;
  playoffChance?: number; playoffSpots?: number; playoffNote: string;
}
export interface PlayerAvailability extends SleeperPlayer { injury_status?: string | null; bye_week?: number; metadataStatus?: 'known' | 'unknown' | 'retired' }
export interface LeagueDetails {
  scoring?: ScoringConfiguration;
  league: SleeperLeague; rosters: SleeperRoster[]; users: SleeperLeagueUser[];
  matchups: SleeperMatchup[]; transactions: SleeperTransaction[]; lastSyncedAt: string;
  players?: Record<string, PlayerAvailability>; playerError?: string;
  playerMetadata?: {
    synchronizedAt: string | null; stale: boolean; lastAttemptedAt: string | null;
    nextAttemptAt: string | null; lastError: string | null;
    unknownPlayerIds: string[]; retiredPlayerIds: string[];
  };
}
