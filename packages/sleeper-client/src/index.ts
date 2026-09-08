const BASE_URL = 'https://api.sleeper.app/v1';
export interface SleeperUser { user_id: string; username: string; display_name: string; avatar: string | null; metadata?: { updated_at?: string }; }
export interface SleeperLeague { league_id: string; name: string; season: string; season_type?: string; status: string; total_rosters?: number; roster_positions: string[]; scoring_settings?: Record<string, number>; settings?: { leg?: number }; metadata?: { updated_at?: string }; }
export interface SleeperRoster { roster_id: number; owner_id: string | null; players: string[] | null; starters: string[] | null; settings: Record<string, number | null>; metadata?: { updated_at?: string }; }
export interface SleeperMatchup { roster_id: number; matchup_id: number | null; players: string[] | null; starters: string[] | null; points: number; custom_points?: number | null; }
export interface SleeperTransaction { transaction_id: string; type: string; status: string; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null; waiver_budget?: Array<{ sender: number; receiver: number; amount: number }>; created?: number; }
export interface SleeperDraftPick { season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number; }
export interface SleeperPlayer { player_id: string; first_name?: string | null; last_name?: string | null; full_name?: string | null; team?: string | null; position?: string | null; fantasy_positions?: string[] | null; active?: boolean; }
export type SleeperPlayers = Record<string, SleeperPlayer>;
export type SleeperErrorKind = 'timeout' | 'network' | 'rate_limit' | 'not_found' | 'upstream' | 'invalid_response';
export class SleeperClientError extends Error { constructor(public readonly kind: SleeperErrorKind, message: string, public readonly status?: number, options?: ErrorOptions) { super(message, options); this.name = 'SleeperClientError'; } }
export interface SleeperClientOptions { timeoutMs?: number; maxRetries?: number; baseDelayMs?: number; baseUrl?: string; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (key: string) => (value: unknown) => object(value) && typeof value[key] === 'string';
const arrayOf = (predicate: (v: unknown) => boolean) => (value: unknown) => Array.isArray(value) && value.every(predicate);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class SleeperClient {
  private readonly options: Required<SleeperClientOptions>;
  constructor(private readonly fetcher: typeof fetch = fetch, options: SleeperClientOptions = {}) { this.options = { timeoutMs: 10_000, maxRetries: 2, baseDelayMs: 200, baseUrl: BASE_URL, ...options }; }
  private async get<T>(path: string, validate: (value: unknown) => boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(`${this.options.baseUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.options.timeoutMs) });
        if (!response.ok) {
          const kind: SleeperErrorKind = response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limit' : 'upstream';
          const error = new SleeperClientError(kind, `Sleeper API returned ${response.status}`, response.status);
          if (attempt < this.options.maxRetries && (response.status === 429 || response.status >= 500)) { await delay(this.options.baseDelayMs * 2 ** attempt); continue; }
          throw error;
        }
        let body: unknown;
        try { body = await response.json(); } catch (cause) { throw new SleeperClientError('invalid_response', `Sleeper returned malformed JSON for ${path}`, response.status, { cause }); }
        if (!validate(body)) throw new SleeperClientError('invalid_response', `Invalid Sleeper response for ${path}`);
        return body as T;
      } catch (cause) {
        if (cause instanceof SleeperClientError) throw cause;
        const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        if (attempt < this.options.maxRetries) { await delay(this.options.baseDelayMs * 2 ** attempt); continue; }
        throw new SleeperClientError(timeout ? 'timeout' : 'network', timeout ? 'Sleeper request timed out' : 'Sleeper network request failed', undefined, { cause });
      }
    }
  }
  user(username: string) { return this.get<SleeperUser>(`/user/${encodeURIComponent(username)}`, has('user_id')); }
  userById(userId: string) { return this.get<SleeperUser>(`/user/${encodeURIComponent(userId)}`, has('user_id')); }
  leagues(userId: string, season: string) { return this.get<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${season}`, arrayOf(has('league_id'))); }
  league(leagueId: string) { return this.get<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`, has('league_id')); }
  rosters(leagueId: string) { return this.get<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`, arrayOf(v => object(v) && typeof v.roster_id === 'number')); }
  matchups(leagueId: string, week: number) { return this.get<SleeperMatchup[]>(`/league/${encodeURIComponent(leagueId)}/matchups/${week}`, arrayOf(v => object(v) && typeof v.roster_id === 'number')); }
  transactions(leagueId: string, week: number) { return this.get<SleeperTransaction[]>(`/league/${encodeURIComponent(leagueId)}/transactions/${week}`, arrayOf(has('transaction_id'))); }
  tradedPicks(leagueId: string) { return this.get<SleeperDraftPick[]>(`/league/${encodeURIComponent(leagueId)}/traded_picks`, arrayOf(v => object(v) && typeof v.round === 'number')); }
  nflPlayers() { return this.get<SleeperPlayers>('/players/nfl', object); }
}
