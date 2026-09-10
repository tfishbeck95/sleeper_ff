import type { LeagueDetails, PlayerAvailability } from './types';

const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {};
const base = env.VITE_API_URL ?? '';
// The CSRF token is deliberately memory-only: persisting it would hand a token to anything that can read
// storage, and the session endpoint mints a fresh one whenever a reloaded page needs it.
let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }
let signedOut: () => void = () => {};
/** Lets the shell return to the sign-in screen the moment the API reports the session is gone. */
export function onSessionEnded(handler: () => void) { signedOut = handler; }
function failed(status: number, body: { error?: string } | null) {
  if (status === 401) { csrfToken = ''; signedOut(); }
  return new Error(body?.error ?? `The request failed (${status}). Please try again.`);
}
export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw failed(response.status, await response.json().catch(() => null));
  return response.json() as Promise<T>;
}
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw failed(response.status, value);
  return value as T;
}
export interface AccountUser { id: string; login: string; sleeperUserId?: string; sleeperUsername?: string; sleeperLeagueIds: string[]; }
/** Restores a reload from the session cookie alone; returns null when there is no live session to resume. */
export async function resumeSession(): Promise<AccountUser | null> {
  try {
    const resumed = await request<{ user: AccountUser; csrfToken: string }>('/auth/session');
    setCsrfToken(resumed.csrfToken);
    return resumed.user;
  } catch { return null; }
}
export async function signOut(everywhere = false) {
  try { await post(everywhere ? '/auth/logout-all' : '/auth/logout', {}); } finally { csrfToken = ''; }
}
let playerCache: { at: number; players: Record<string, PlayerAvailability> } | undefined;
async function players(signal: AbortSignal) {
  if (playerCache && Date.now() - playerCache.at < 24 * 60 * 60_000) return playerCache.players;
  const response = await fetch('https://api.sleeper.app/v1/players/nfl', { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new Error('Player availability could not be refreshed.');
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Player availability is unavailable.');
  playerCache = { at: Date.now(), players: value };
  return playerCache.players;
}
export async function loadLeague(leagueId: string, week: number, signal: AbortSignal) {
  const [detailResult, playerResult] = await Promise.allSettled([
    request<LeagueDetails>(`/api/sleeper/leagues/${encodeURIComponent(leagueId)}?week=${week}`, signal),
    players(signal),
  ]);
  if (detailResult.status === 'rejected') throw detailResult.reason;
  return {
    details: { ...detailResult.value, ...(playerResult.status === 'fulfilled' ? { players: playerResult.value } : { playerError: 'Player availability could not be loaded. Injury and inactive checks are incomplete.' }) },
    snapshot: null,
  };
}
