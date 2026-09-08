const BASE_URL = 'https://api.sleeper.app/v1';
export interface SleeperUser { user_id: string; username: string; display_name: string; avatar: string | null; }
export interface SleeperLeague { league_id: string; name: string; season: string; status: string; roster_positions: string[]; }
export interface SleeperRoster { roster_id: number; owner_id: string | null; players: string[] | null; starters: string[] | null; settings: { wins?: number; losses?: number; ties?: number; fpts?: number }; }

export class SleeperClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${BASE_URL}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Sleeper API returned ${response.status}`);
    return response.json() as Promise<T>;
  }
  user(username: string) { return this.get<SleeperUser>(`/user/${encodeURIComponent(username)}`); }
  leagues(userId: string, season: string) { return this.get<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${season}`); }
  rosters(leagueId: string) { return this.get<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`); }
}
