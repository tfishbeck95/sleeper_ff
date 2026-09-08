import type { LeagueDetails, PlayerAvailability } from './types';

const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {};
const base = env.VITE_API_URL ?? '';
export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${env.VITE_API_TOKEN ?? 'demo-token'}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `The request failed (${response.status}). Please try again.`);
  }
  return response.json() as Promise<T>;
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
