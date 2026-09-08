export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF';
export type Trend = 'up' | 'down' | 'steady';
export interface Player { id: string; name: string; team: string; position: Position; projectedPoints: number; trend: Trend; }
export interface Matchup { week: number; opponent: string; projectedFor: number; projectedAgainst: number; }
export interface Recommendation { id: string; kind: 'start' | 'waiver' | 'trade'; title: string; rationale: string; confidence: number; player?: Player; actionLabel: string; }
export interface LeagueSnapshot { leagueId: string; leagueName: string; username: string; season: string; week: number; record: string; rank: number; pointsFor: number; lastSyncedAt: string; roster: Player[]; matchup: Matchup; recommendations: Recommendation[]; }

export function scoreStartDecision(player: Pick<Player, 'projectedPoints' | 'trend'>): number {
  const trendBonus = player.trend === 'up' ? 1.5 : player.trend === 'down' ? -1 : 0;
  return Math.round((player.projectedPoints + trendBonus) * 10) / 10;
}
