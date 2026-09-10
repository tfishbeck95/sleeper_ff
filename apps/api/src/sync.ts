import { liveScoring, scoringUnavailable, type ScoringConfiguration } from '@sleeper/domain';
import type { League, Matchup, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';
import { SleeperApiError, SleeperClient, type SleeperDraftPick, type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction } from '@sleeper/sleeper-client';
import { JsonStore, type SyncWrite } from './store.js';
import { PlayerDirectoryService, PLAYER_REFRESH_MS } from './players.js';

export const REFRESH_AFTER_MS = { users: 6 * 60 * 60_000, rosters: 5 * 60_000, matchups: 2 * 60_000, transactions: 2 * 60_000, draftPicks: 5 * 60_000, players: PLAYER_REFRESH_MS } as const;
export interface SyncResult { leagueId: string; synchronizedAt: string; refreshed: string[]; snapshotId?: string; scoring: ScoringConfiguration; }
export interface SyncLogger { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void; }
const defaultLogger: SyncLogger = { info: (fields, message) => console.info(message, fields), error: (fields, message) => console.error(message, fields) };
const isoFromEpoch = (epoch?: number) => epoch ? new Date(epoch).toISOString() : null;
const source = (synchronizedAt: string, epoch?: number) => ({ sourceUpdatedAt: isoFromEpoch(epoch), synchronizedAt });

export class LeagueSyncService {
  private readonly locks = new Map<string, Promise<SyncResult>>();
  constructor(private readonly store: JsonStore, private readonly client = new SleeperClient(), private readonly logger: SyncLogger = defaultLogger, private readonly now = () => new Date()) {}
  syncLeague(leagueId: string, week: number, force = false): Promise<SyncResult> {
    const existing = this.locks.get(leagueId); if (existing) return existing;
    const job = this.perform(leagueId, week, force).finally(() => this.locks.delete(leagueId)); this.locks.set(leagueId, job); return job;
  }
  /** Used by both the dashboard and background synchronization; never reads the reference file. */
  async synchronizeLeagueMetadata(leagueId: string, at = this.now().toISOString()): Promise<SleeperLeague> {
    try {
      const raw = await this.client.league(leagueId);
      if (raw.league_id !== leagueId) throw new Error('Sleeper returned a different league.');
      await this.store.applySync({ league: this.league(raw, at), freshness: { [`league:${leagueId}`]: at } });
      return raw;
    } catch (error) {
      const previous = await this.store.league(leagueId);
      if (previous) await this.store.applySync({ league: { ...previous, scoring: {
        ...scoringUnavailable('Live scoring could not be refreshed. Retry synchronization before using rankings.', previous.scoring?.synchronizedAt ?? null),
        rawSettings: previous.scoring?.rawSettings ?? null, lastAttemptedAt: at,
      } } });
      throw error;
    }
  }
  private async stale(key: string, ttl: number, force: boolean) { const value = await this.store.resourceSyncedAt(key); return force || !value || this.now().getTime() - new Date(value).getTime() >= ttl; }
  private async perform(leagueId: string, week: number, force: boolean): Promise<SyncResult> {
    const started = Date.now(); const synchronizedAt = this.now().toISOString(); const refreshed: string[] = []; const write: SyncWrite = { freshness: {} };
    try {
      const obtain = async <T>(name: keyof typeof REFRESH_AFTER_MS, key: string, fetch: () => Promise<T>): Promise<T | undefined> => {
        if (!(await this.stale(key, REFRESH_AFTER_MS[name], force))) return undefined;
        const value = await fetch(); write.freshness![key] = synchronizedAt; refreshed.push(name); return value;
      };
      const rawLeague = await this.synchronizeLeagueMetadata(leagueId, synchronizedAt);
      refreshed.push('league');
      const season = rawLeague.season;
      const scoring = liveScoring(rawLeague.scoring_settings, synchronizedAt);
      const [users, rosters, matchups, transactions, picks, players] = await Promise.all([
        obtain('users', `users:${leagueId}`, () => this.client.leagueUsers(leagueId)),
        obtain('rosters', `rosters:${leagueId}`, () => this.client.rosters(leagueId)),
        obtain('matchups', `matchups:${leagueId}:${season}:${week}`, () => this.client.matchups(leagueId, week)),
        obtain('transactions', `transactions:${leagueId}:${season}:${week}`, () => this.client.transactions(leagueId, week)),
        obtain('draftPicks', `draftPicks:${leagueId}`, () => this.client.tradedPicks(leagueId)),
        new PlayerDirectoryService(this.store, this.client, this.now).refresh()
      ]);
      if (users) write.users = users.map(value => ({ id: value.user_id, username: value.username, displayName: value.display_name, avatarId: value.avatar, ...source(synchronizedAt) } satisfies User));
      if (rosters) write.rosters = rosters.map(value => this.roster(leagueId, value, synchronizedAt));
      if (matchups) write.matchups = matchups.map(value => this.matchup(leagueId, season, week, value, synchronizedAt));
      if (transactions) write.transactions = transactions.map(value => this.transaction(leagueId, week, value, synchronizedAt));
      if (picks) { write.draftPicks = picks.map(value => this.pick(leagueId, value, synchronizedAt)); write.replaceDraftPicksForLeague = leagueId; }
      if (players) refreshed.push('players');
      if (write.rosters || write.matchups) {
        const snapshotRosters = write.rosters ?? await this.store.rosters(leagueId); const snapshotMatchups = write.matchups ?? [];
        const id = `${leagueId}:${season}:${week}:${synchronizedAt}`;
        write.weeklySnapshot = { id, leagueId, season, week, rosterIds: snapshotRosters.map(v => v.id), matchupIds: snapshotMatchups.map(v => v.id), rosters: snapshotRosters, matchups: snapshotMatchups, scoring, ...source(synchronizedAt) };
      }
      await this.store.applySync(write); await this.store.recordSync(leagueId, 'success', synchronizedAt, Date.now() - started);
      this.logger.info({ leagueId, durationMs: Date.now() - started, refreshed, synchronizedAt }, 'league synchronization completed');
      return { leagueId, synchronizedAt, refreshed, scoring, ...(write.weeklySnapshot ? { snapshotId: write.weeklySnapshot.id } : {}) };
    } catch (error) {
      const category = error instanceof SleeperApiError ? error.category : 'internal'; await this.store.recordSync(leagueId, 'failed', synchronizedAt, Date.now() - started, category);
      this.logger.error({ leagueId, durationMs: Date.now() - started, category }, 'league synchronization failed'); throw error;
    }
  }
  private league(v: SleeperLeague, at: string): League { return { id: v.league_id, name: v.name, season: v.season, status: v.status, previousLeagueId: v.previous_league_id ?? null, totalRosters: v.total_rosters ?? null, scoring: liveScoring(v.scoring_settings, at), scoringSettings: [], rosterPositions: v.roster_positions.map((position, slot) => ({ position, slot })), settings: v.settings, seasonType: v.season_type, ...source(at) }; }
  private roster(leagueId: string, v: SleeperRoster, at: string): Roster { return { id: `${leagueId}:${v.roster_id}`, leagueId, rosterId: v.roster_id, ownerId: v.owner_id, coOwnerIds: v.co_owners ?? [], playerIds: v.players ?? [], starterIds: v.starters ?? [], reserveIds: v.reserve ?? [], taxiIds: v.taxi ?? [], settings: Object.fromEntries(Object.entries(v.settings).filter((entry): entry is [string, number] => typeof entry[1] === 'number')), ...source(at) }; }
  private matchup(leagueId: string, season: string, week: number, v: SleeperMatchup, at: string): Matchup { return { id: `${leagueId}:${season}:${week}:${v.roster_id}`, leagueId, season, week, matchupId: v.matchup_id, rosterId: v.roster_id, points: v.points, customPoints: v.custom_points ?? null, playerIds: v.players, starterIds: v.starters, playerPoints: v.players_points ?? {}, ...source(at) }; }
  private transaction(leagueId: string, week: number, v: SleeperTransaction, at: string): Transaction { return { id: v.transaction_id, leagueId, week, type: v.type, status: v.status, rosterIds: v.roster_ids, adds: v.adds ?? {}, drops: v.drops ?? {}, draftPicks: v.draft_picks.map(p => ({ season: p.season, round: p.round, rosterId: p.roster_id, previousOwnerId: p.previous_owner_id ?? null, ownerId: p.owner_id })), waiverBudget: v.waiver_budget ?? [], ...source(at, v.status_updated ?? v.created) }; }
  private pick(leagueId: string, v: SleeperDraftPick, at: string): TradedDraftPick { return { id: `${leagueId}:${v.season}:${v.round}:${v.roster_id}`, leagueId, season: v.season, round: v.round, rosterId: v.roster_id, previousOwnerId: v.previous_owner_id ?? null, ownerId: v.owner_id, ...source(at) }; }
}
