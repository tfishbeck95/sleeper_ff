export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF';
export type IsoTimestamp = string;
export interface SyncMetadata { sourceUpdatedAt: IsoTimestamp | null; syncedAt: IsoTimestamp; }
export interface User extends SyncMetadata { id: string; username: string; displayName: string; avatarId: string | null; }
export interface ScoringSettings { [category: string]: number; }
export interface League extends SyncMetadata { id: string; name: string; season: string; seasonType: string; status: string; totalRosters: number; scoringSettings: ScoringSettings; rosterPositions: string[]; }
export interface NflPlayer extends SyncMetadata { id: string; firstName: string; lastName: string; fullName: string; team: string | null; position: string | null; fantasyPositions: string[]; active: boolean; }
export interface Roster extends SyncMetadata { id: string; leagueId: string; ownerId: string | null; playerIds: string[]; starterIds: string[]; settings: Record<string, number | null>; }
export interface Matchup extends SyncMetadata { id: string; leagueId: string; week: number; rosterId: string; matchupId: number | null; playerIds: string[]; starterIds: string[]; points: number; customPoints: number | null; }
export interface Transaction extends SyncMetadata { id: string; leagueId: string; week: number; type: string; status: string; rosterIds: string[]; adds: Record<string, number>; drops: Record<string, number>; waiverBudget: Array<{ sender: number; receiver: number; amount: number }>; }
export interface DraftPick extends SyncMetadata { id: string; leagueId: string; season: string; round: number; rosterId: string; previousOwnerId: string; ownerId: string; }
export interface WeeklySnapshot { id: string; leagueId: string; season: string; week: number; roster: Roster; matchups: Matchup[]; sourceUpdatedAt: IsoTimestamp | null; syncedAt: IsoTimestamp; }
export type Trend = 'up' | 'down' | 'steady';
export interface Player { id: string; name: string; team: string; position: Position; projectedPoints: number; trend: Trend; }
export interface DashboardMatchup { week: number; opponent: string; projectedFor: number; projectedAgainst: number; }
export interface Recommendation { id: string; kind: 'start' | 'waiver' | 'trade'; title: string; rationale: string; confidence: number; player?: Player; actionLabel: string; }
export interface LeagueSnapshot { leagueId: string; leagueName: string; username: string; season: string; week: number; record: string; rank: number; pointsFor: number; lastSyncedAt: string; roster: Player[]; matchup: DashboardMatchup; recommendations: Recommendation[]; }

export function scoreStartDecision(player: Pick<Player, 'projectedPoints' | 'trend'>): number {
  const trendBonus = player.trend === 'up' ? 1.5 : player.trend === 'down' ? -1 : 0;
  return Math.round((player.projectedPoints + trendBonus) * 10) / 10;
}
