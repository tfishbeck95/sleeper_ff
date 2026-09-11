import { randomUUID } from 'node:crypto';
import type { NflPlayer } from '@sleeper/domain';
import { SleeperApiError, type SleeperClient, type SleeperMatchup, type SleeperRoster, type SleeperTransaction } from '@sleeper/sleeper-client';
import type { LeaseRepository, PlayerRepository } from './storage/repositories.js';
import { logger } from './log.js';
import { sleeperClient } from './config/upstream.js';

/** The directory and the lease that keeps one refresh in flight at a time. */
type PlayerDirectoryRepository = PlayerRepository & LeaseRepository;

export const PLAYER_REFRESH_MS = 24 * 60 * 60_000;
export const PLAYER_RETRY_MS = 60 * 60_000;
const jobs = new WeakMap<PlayerDirectoryRepository, Promise<boolean>>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validPlayerId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== '0';
const retired = (status: string | null) => ['retired', 'deceased'].includes((status ?? '').toLowerCase());

/** All field validation and normalization happens at ingestion, before the atomic publication. */
export function normalizePlayers(raw: unknown, at: string): NflPlayer[] {
  const invalid = () => new SleeperApiError(502, 'Invalid NFL player directory.', 'validation');
  if (!object(raw) || !Object.keys(raw).length) throw invalid();
  return Object.entries(raw).map(([id, value]) => {
    if (!validPlayerId(id) || !object(value) || value.player_id !== id) throw invalid();
    const string = (key: string) => {
      const field = value[key];
      if (field == null) return null;
      if (typeof field !== 'string') throw invalid();
      return field.trim() || null;
    };
    const firstName = string('first_name'), lastName = string('last_name');
    const fullName = string('full_name') ?? ([firstName, lastName].filter(Boolean).join(' ') || id);
    const positions = value.fantasy_positions;
    if (positions != null && (!Array.isArray(positions) || !positions.every(p => typeof p === 'string' && p.trim()))) throw invalid();
    return {
      id, firstName, lastName, fullName, team: string('team'), position: string('position'),
      fantasyPositions: [...new Set((positions as string[] | null | undefined ?? []).map(p => p.trim()))],
      status: string('status'), injuryStatus: string('injury_status'),
      sourceUpdatedAt: null, synchronizedAt: at,
    };
  });
}

export function leaguePlayerIds(rosters: SleeperRoster[], matchups: SleeperMatchup[], transactions: SleeperTransaction[]) {
  return [...new Set([
    ...rosters.flatMap(r => [...r.players ?? [], ...r.starters ?? [], ...r.reserve ?? [], ...r.taxi ?? []]),
    ...matchups.flatMap(m => [...m.players ?? [], ...m.starters ?? [], ...Object.keys(m.players_points ?? {})]),
    ...transactions.flatMap(t => [...Object.keys(t.adds ?? {}), ...Object.keys(t.drops ?? {})]),
  ].filter(validPlayerId))].sort();
}

export class PlayerDirectoryService {
  constructor(private readonly store: PlayerDirectoryRepository, private readonly client = sleeperClient('interactive'), private readonly now = () => new Date()) {}

  /** Serve stored availability immediately during a slow refresh. Cold starts get a short budget
   * to populate names, then return placeholders while ingestion continues in the background. */
  async prepareRead() {
    const { metadata, players } = await this.store.playerDirectory();
    if (metadata && Date.parse(metadata.nextAttemptAt) > this.now().getTime()) return;
    const refresh = this.refresh().catch(error => { logger.error({ component: 'players', error }, 'player directory storage failure'); });
    if (metadata?.synchronizedAt || Object.keys(players).length) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Not unref'd. An unref'd timer does not hold the event loop open, so the budget only elapsed
    // when something else — a listening server — happened to be holding it; with nothing else
    // pending, the race never settled at all and this call hung. It is cleared in `finally` either
    // way, so the most it can hold the loop for is the one second it is meant to wait.
    try { await Promise.race([refresh, new Promise<void>(resolve => { timeout = setTimeout(resolve, 1_000); })]); }
    finally { clearTimeout(timeout); }
  }

  /** Global, independent of league force-refresh; every caller joins the same in-flight refresh. */
  refresh(): Promise<boolean> {
    const current = jobs.get(this.store);
    if (current) return current;
    const job = this.performRefresh().finally(() => jobs.delete(this.store));
    jobs.set(this.store, job);
    return job;
  }

  private async performRefresh(): Promise<boolean> {
    const now = this.now();
    const { metadata } = await this.store.playerDirectory();
    if (metadata && Date.parse(metadata.nextAttemptAt) > now.getTime()) return false;
    const owner = randomUUID();
    if (!await this.store.acquireLease('players:nfl', owner, 5 * 60_000, now)) return false;
    try {
      const previous = (await this.store.playerDirectory()).metadata;
      if (previous && Date.parse(previous.nextAttemptAt) > now.getTime()) return false;
      const at = now.toISOString();
      // Persist a cooldown before fetching, so a restart mid-request cannot trigger a fetch storm.
      await this.store.savePlayerDirectory({ synchronizedAt: previous?.synchronizedAt ?? null, lastAttemptedAt: at, nextAttemptAt: new Date(now.getTime() + PLAYER_RETRY_MS).toISOString(), lastError: 'refresh_incomplete' });
      try {
        const players = normalizePlayers(await this.client.players(), at);
        await this.store.savePlayerDirectory({ synchronizedAt: at, lastAttemptedAt: at, nextAttemptAt: new Date(now.getTime() + PLAYER_REFRESH_MS).toISOString(), lastError: null }, players);
        return true;
      } catch (error) {
        const category = error instanceof SleeperApiError ? error.category : 'network';
        const delay = Math.max(PLAYER_RETRY_MS, error instanceof SleeperApiError ? error.retryAfterMs ?? 0 : 0);
        await this.store.savePlayerDirectory({ synchronizedAt: previous?.synchronizedAt ?? null, lastAttemptedAt: at, nextAttemptAt: new Date(now.getTime() + delay).toISOString(), lastError: category });
        logger.error({ component: 'players', category, synchronizedAt: previous?.synchronizedAt ?? null }, 'player directory refresh failed; retaining the last good directory');
        return false;
      }
    } finally { await this.store.releaseLease('players:nfl', owner); }
  }

  /** An explicit ID selection or bounded name search; never serialize the global directory. */
  async subset(selection: { ids: string[] } | { query: string; limit: number }) {
    const { players: directory, metadata } = await this.store.playerDirectory();
    const ids = 'ids' in selection ? [...new Set(selection.ids.filter(validPlayerId))].sort()
      : Object.values(directory).filter(p => `${p.fullName} ${p.id}`.toLowerCase().includes(selection.query.toLowerCase()))
        .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id)).slice(0, selection.limit).map(p => p.id);
    const unknownPlayerIds: string[] = [], retiredPlayerIds: string[] = [];
    const players = Object.fromEntries(ids.map(id => {
      const player = Object.hasOwn(directory, id) ? directory[id] : undefined;
      if (!player) {
        unknownPlayerIds.push(id);
        return [id, { player_id: id, full_name: `Player ${id}`, status: null, metadataStatus: 'unknown' as const }];
      }
      if (retired(player.status)) retiredPlayerIds.push(id);
      return [id, {
        player_id: id, full_name: player.fullName, first_name: player.firstName, last_name: player.lastName,
        team: player.team, position: player.position, fantasy_positions: player.fantasyPositions,
        status: player.status, injury_status: player.injuryStatus ?? null,
        metadataStatus: retired(player.status) ? 'retired' as const : 'known' as const,
      }];
    }));
    const synchronizedAt = metadata?.synchronizedAt ?? null;
    const stale = !synchronizedAt || this.now().getTime() - Date.parse(synchronizedAt) >= PLAYER_REFRESH_MS;
    const playerError = !synchronizedAt ? 'Player availability is unavailable. Injury and inactive checks are incomplete.'
      : stale || metadata?.lastError ? 'Player availability could not be refreshed. Showing the last good dataset; verify current status in Sleeper.'
        : unknownPlayerIds.length ? 'Some player IDs have no metadata. Their availability checks are incomplete.' : undefined;
    return {
      players, playerMetadata: { synchronizedAt, stale, lastAttemptedAt: metadata?.lastAttemptedAt ?? null, nextAttemptAt: metadata?.nextAttemptAt ?? null, lastError: metadata?.lastError ?? null, unknownPlayerIds, retiredPlayerIds },
      ...(playerError ? { playerError } : {}),
    };
  }
}
