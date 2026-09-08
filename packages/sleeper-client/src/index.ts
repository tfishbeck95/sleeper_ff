const BASE_URL = 'https://api.sleeper.app/v1';

export interface SleeperUser { user_id: string; username: string; display_name: string; avatar: string | null; metadata?: Record<string, string>; }
export interface SleeperLeague { league_id: string; name: string; season: string; status: string; season_type?: string; total_rosters?: number; avatar?: string | null; previous_league_id?: string | null; roster_positions: string[]; settings: Record<string, number>; scoring_settings?: Record<string, number>; }
export interface SleeperRoster { roster_id: number; owner_id: string | null; co_owners?: string[] | null; players: string[] | null; starters: string[] | null; reserve?: string[] | null; taxi?: string[] | null; settings: { wins?: number; losses?: number; ties?: number; fpts?: number; [key: string]: number | undefined }; metadata?: Record<string, string>; }
export interface SleeperLeagueUser extends SleeperUser { is_owner?: boolean; metadata?: Record<string, string>; }
export interface SleeperMatchup { matchup_id: number | null; roster_id: number; points: number; custom_points?: number | null; players: string[]; starters: string[]; players_points?: Record<string, number>; starters_points?: number[]; }
export interface SleeperTransaction { transaction_id: string; type: 'trade' | 'waiver' | 'free_agent' | 'commissioner'; status: string; status_updated?: number; created?: number; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null; draft_picks: SleeperDraftPick[]; waiver_budget?: Array<{ sender: number; receiver: number; amount: number }>; }
export interface SleeperDraft { draft_id: string; league_id: string; season: string; status: string; type: string; sport: string; settings: Record<string, number>; metadata: Record<string, string>; created?: number; start_time?: number; }
export interface SleeperDraftPick { season: string; round: number; roster_id: number; previous_owner_id?: number; owner_id: number; }

export class SleeperApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SleeperApiError'; }
}

export class SleeperClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly baseUrl = BASE_URL) {}
  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try { response = await this.fetcher(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new SleeperApiError(503, error instanceof Error ? error.message : 'Sleeper API is unavailable'); }
    if (!response.ok) throw new SleeperApiError(response.status, `Sleeper API returned ${response.status}`);
    return response.json() as Promise<T>;
  }
  user(username: string) { return this.get<SleeperUser | null>(`/user/${encodeURIComponent(username.trim())}`); }
  leagues(userId: string, season: string | number) { return this.get<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(String(season))}`); }
  league(leagueId: string) { return this.get<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`); }
  rosters(leagueId: string) { return this.get<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`); }
  leagueUsers(leagueId: string) { return this.get<SleeperLeagueUser[]>(`/league/${encodeURIComponent(leagueId)}/users`); }
  matchups(leagueId: string, week: number) { return this.get<SleeperMatchup[]>(`/league/${encodeURIComponent(leagueId)}/matchups/${week}`); }
  transactions(leagueId: string, round: number) { return this.get<SleeperTransaction[]>(`/league/${encodeURIComponent(leagueId)}/transactions/${round}`); }
  drafts(leagueId: string) { return this.get<SleeperDraft[]>(`/league/${encodeURIComponent(leagueId)}/drafts`); }
  tradedPicks(leagueId: string) { return this.get<SleeperDraftPick[]>(`/league/${encodeURIComponent(leagueId)}/traded_picks`); }
}
