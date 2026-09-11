const BASE_URL = 'https://api.sleeper.app/v1';

export interface SleeperUser { user_id: string; username: string; display_name: string; avatar: string | null; metadata?: Record<string, string>; }
export interface SleeperLeague { league_id: string; name: string; season: string; status: string; season_type?: string; total_rosters?: number; avatar?: string | null; previous_league_id?: string | null; roster_positions: string[]; settings: Record<string, number>; scoring_settings?: Record<string, number>; }
export interface SleeperRoster { roster_id: number; owner_id: string | null; co_owners?: string[] | null; players: string[] | null; starters: string[] | null; reserve?: string[] | null; taxi?: string[] | null; settings: { wins?: number; losses?: number; ties?: number; fpts?: number; [key: string]: number | undefined }; metadata?: Record<string, string>; }
export interface SleeperLeagueUser extends SleeperUser { is_owner?: boolean; }
export interface SleeperMatchup { matchup_id: number | null; roster_id: number; points: number; custom_points?: number | null; players: string[]; starters: string[]; players_points?: Record<string, number>; starters_points?: number[]; }
export interface SleeperTransaction { transaction_id: string; type: 'trade' | 'waiver' | 'free_agent' | 'commissioner'; status: string; status_updated?: number; created?: number; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null; draft_picks: SleeperDraftPick[]; waiver_budget?: Array<{ sender: number; receiver: number; amount: number }>; }
export interface SleeperDraft { draft_id: string; league_id: string; season: string; status: string; type: string; sport: string; settings: Record<string, number>; metadata: Record<string, string>; created?: number; start_time?: number; }
export interface SleeperDraftPick { season: string; round: number; roster_id: number; previous_owner_id?: number; owner_id: number; }
export interface SleeperPlayer { player_id: string; injury_status?: string | null; first_name?: string | null; last_name?: string | null; full_name?: string | null; team?: string | null; position?: string | null; fantasy_positions?: string[] | null; status?: string | null; }

export type SleeperErrorCategory = 'timeout' | 'network' | 'rate_limit' | 'not_found' | 'server' | 'client' | 'validation';
export class SleeperApiError extends Error {
  /**
   * `retryAfterMs` is upstream's own guidance, not ours. It is carried on the error rather than
   * swallowed by the internal retry loop so a caller that can wait — the background synchronization
   * worker — schedules its next attempt when Sleeper said to, instead of guessing a backoff.
   */
  constructor(public readonly status: number, message: string, public readonly category: SleeperErrorCategory, public readonly retryable = false, public readonly retryAfterMs: number | null = null) { super(message); this.name = 'SleeperApiError'; }
}
export interface SleeperClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  maxRetryAfterMs?: number;
  /**
   * The ceiling on one call in total, across every attempt and every wait between them.
   *
   * Per-attempt timeouts bound a slow answer; they do not bound a chain of them. Three attempts that
   * each take the full timeout, with backoff, is a request held open for several times longer than
   * any single number in this object suggests — which is how a browser ends up waiting a minute on a
   * client configured to wait ten seconds. Retrying stops once the remaining budget cannot hold
   * another attempt, and the last failure is thrown as it stands.
   */
  maxElapsedMs?: number;
}

/**
 * `Retry-After` as milliseconds, or null when the header is absent or unusable.
 *
 * Both documented forms are accepted: delay-seconds and an HTTP date. A date already in the past is
 * zero rather than a negative delay, and anything unparseable is null so a malformed header can never
 * become an accidental instant retry or an unbounded wait.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasId = (key: string) => (value: unknown) => object(value) && typeof value[key] === 'string';
const arrayOf = (guard: (value: unknown) => boolean) => (value: unknown) => Array.isArray(value) && value.every(guard);

export class SleeperClient {
  private readonly options: Required<SleeperClientOptions>;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly baseUrl = BASE_URL, options: SleeperClientOptions = {}) {
    this.options = { timeoutMs: options.timeoutMs ?? 10_000, maxRetries: options.maxRetries ?? 2, backoffMs: options.backoffMs ?? 200, maxRetryAfterMs: options.maxRetryAfterMs ?? 5_000, maxElapsedMs: options.maxElapsedMs ?? 20_000 };
  }
  private async get<T>(path: string, validate: (value: unknown) => boolean): Promise<T> {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      // Each attempt gets whatever is left of the whole-call budget, so a chain of slow answers
      // cannot outlive it even when every individual one is inside the per-attempt timeout.
      const remaining = this.options.maxElapsedMs - (Date.now() - startedAt);
      const timeoutMs = Math.max(1, Math.min(this.options.timeoutMs, remaining));
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          const category: SleeperErrorCategory = response.status === 429 ? 'rate_limit' : response.status === 404 ? 'not_found' : response.status >= 500 ? 'server' : 'client';
          const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
          throw new SleeperApiError(response.status, `Sleeper API returned ${response.status}`, category, response.status === 429 || response.status >= 500, retryAfterMs);
        }
        const value: unknown = await response.json();
        if (!validate(value)) throw new SleeperApiError(502, `Invalid Sleeper response for ${path}`, 'validation');
        return value as T;
      } catch (error) {
        const normalized = error instanceof SleeperApiError ? error : new SleeperApiError(503, error instanceof Error ? error.message : 'Sleeper API is unavailable', error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network', true);
        if (!normalized.retryable || attempt >= this.options.maxRetries) throw normalized;
        // A caller is waiting on this request. Upstream's own delay is honoured while it stays inside
        // the in-request budget; a longer one is handed back on the error for the worker to schedule,
        // because holding a request open for a minute is worse than answering from the last snapshot.
        const wait = normalized.retryAfterMs ?? this.options.backoffMs * 2 ** attempt;
        if (wait > this.options.maxRetryAfterMs) throw normalized;
        // Waiting past the deadline to start an attempt that would be aborted immediately is worse
        // than failing now: the caller waits the whole remainder to learn what is already known.
        if (Date.now() - startedAt + wait >= this.options.maxElapsedMs) throw normalized;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  user(username: string) { return this.get<SleeperUser | null>(`/user/${encodeURIComponent(username.trim())}`, value => value === null || hasId('user_id')(value)); }
  leagues(userId: string, season: string | number) { return this.get<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(String(season))}`, arrayOf(hasId('league_id'))); }
  league(leagueId: string) { return this.get<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`, hasId('league_id')); }
  rosters(leagueId: string) { return this.get<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`, arrayOf(value => object(value) && typeof value.roster_id === 'number')); }
  leagueUsers(leagueId: string) { return this.get<SleeperLeagueUser[]>(`/league/${encodeURIComponent(leagueId)}/users`, arrayOf(hasId('user_id'))); }
  matchups(leagueId: string, week: number) { return this.get<SleeperMatchup[]>(`/league/${encodeURIComponent(leagueId)}/matchups/${week}`, arrayOf(value => object(value) && typeof value.roster_id === 'number')); }
  transactions(leagueId: string, round: number) { return this.get<SleeperTransaction[]>(`/league/${encodeURIComponent(leagueId)}/transactions/${round}`, arrayOf(hasId('transaction_id'))); }
  drafts(leagueId: string) { return this.get<SleeperDraft[]>(`/league/${encodeURIComponent(leagueId)}/drafts`, arrayOf(hasId('draft_id'))); }
  tradedPicks(leagueId: string) { return this.get<SleeperDraftPick[]>(`/league/${encodeURIComponent(leagueId)}/traded_picks`, arrayOf(value => object(value) && typeof value.roster_id === 'number')); }
  players() { return this.get<Record<string, SleeperPlayer>>('/players/nfl', value => object(value) && Object.values(value).every(player => object(player))); }
}
