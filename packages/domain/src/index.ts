/** Timestamps carried by every record imported from Sleeper. */
export interface SourceMetadata {
  /** Timestamp supplied by Sleeper, when that resource exposes one. */
  sourceUpdatedAt: string | null;
  /** Time at which our synchronization observed this representation. */
  synchronizedAt: string;
}

export interface User extends SourceMetadata { id: string; username: string; displayName: string; avatarId: string | null; }
export interface ScoringSetting { key: string; points: number; }
export interface RosterPosition { position: string; slot: number; }
export interface League extends SourceMetadata {
  id: string; name: string; season: string; status: string; previousLeagueId: string | null;
  totalRosters: number | null; scoringSettings: ScoringSetting[]; rosterPositions: RosterPosition[];
}
export interface NflPlayer extends SourceMetadata {
  id: string; firstName: string | null; lastName: string | null; fullName: string;
  team: string | null; position: string | null; fantasyPositions: string[]; status: string | null;
}
export interface Roster extends SourceMetadata {
  id: string; leagueId: string; rosterId: number; ownerId: string | null; coOwnerIds: string[];
  playerIds: string[]; starterIds: string[]; reserveIds: string[]; taxiIds: string[];
  settings: Record<string, number>;
}
export interface Matchup extends SourceMetadata {
  id: string; leagueId: string; season: string; week: number; matchupId: number | null;
  rosterId: number; points: number; customPoints: number | null; playerIds: string[];
  starterIds: string[]; playerPoints: Record<string, number>;
}
export interface DraftPick { season: string; round: number; rosterId: number; previousOwnerId: number | null; ownerId: number; }
export interface Transaction extends SourceMetadata {
  id: string; leagueId: string; week: number; type: 'trade' | 'waiver' | 'free_agent' | 'commissioner';
  status: string; rosterIds: number[]; adds: Record<string, number>; drops: Record<string, number>;
  draftPicks: DraftPick[]; waiverBudget: Array<{ sender: number; receiver: number; amount: number }>;
}
export interface TradedDraftPick extends SourceMetadata, DraftPick { id: string; leagueId: string; }

/** An append-only observation. The id contains the synchronization timestamp and is never upserted. */
export interface WeeklySnapshot extends SourceMetadata {
  id: string; leagueId: string; season: string; week: number;
  rosterIds: string[]; matchupIds: string[];
  rosters: Roster[]; matchups: Matchup[];
}

// Dashboard view models remain intentionally separate from normalized persistence models.
export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF';
export type Trend = 'up' | 'down' | 'steady';
export interface Player { id: string; name: string; team: string; position: Position; projectedPoints: number; trend: Trend; }
export interface DashboardMatchup { week: number; opponent: string; projectedFor: number; projectedAgainst: number; }
export interface Recommendation { id: string; kind: 'start' | 'waiver' | 'trade'; title: string; rationale: string; confidence: number; player?: Player; actionLabel: string; }
export interface LeagueSnapshot { leagueId: string; leagueName: string; username: string; season: string; week: number; record: string; rank: number; pointsFor: number; lastSyncedAt: string; roster: Player[]; matchup: DashboardMatchup; recommendations: Recommendation[]; }

export function scoreStartDecision(player: Pick<Player, 'projectedPoints' | 'trend'>): number {
  const trendBonus = player.trend === 'up' ? 1.5 : player.trend === 'down' ? -1 : 0;
  return Math.round((player.projectedPoints + trendBonus) * 10) / 10;
}
