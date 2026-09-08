import type { League, Matchup, NflPlayer, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';
import { SleeperApiError, SleeperClient, type SleeperDraftPick, type SleeperLeague, type SleeperMatchup, type SleeperPlayer, type SleeperRoster, type SleeperTransaction } from '@sleeper/sleeper-client';
import { JsonStore, type SyncWrite } from './store.js';

export const REFRESH_AFTER_MS = { league: 60 * 60_000, users: 6 * 60 * 60_000, rosters: 5 * 60_000, matchups: 2 * 60_000, transactions: 2 * 60_000, draftPicks: 60 * 60_000, players: 24 * 60 * 60_000 } as const;
export interface SyncResult { leagueId: string; synchronizedAt: string; refreshed: string[]; snapshotId?: string; }
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
  private async stale(key: string, ttl: number, force: boolean) { const value = await this.store.resourceSyncedAt(key); return force || !value || this.now().getTime() - new Date(value).getTime() >= ttl; }
  private async perform(leagueId: string, week: number, force: boolean): Promise<SyncResult> {
    const started = Date.now(); const synchronizedAt = this.now().toISOString(); const refreshed: string[] = []; const write: SyncWrite = { freshness: {} };
    try {
      const obtain = async <T>(name: keyof typeof REFRESH_AFTER_MS, key: string, fetch: () => Promise<T>): Promise<T | undefined> => {
        if (!(await this.stale(key, REFRESH_AFTER_MS[name], force))) return undefined;
        const value = await fetch(); write.freshness![key] = synchronizedAt; refreshed.push(name); return value;
      };
      const rawLeague = await obtain('league', `league:${leagueId}`, () => this.client.league(leagueId));
      const knownLeague = rawLeague ?? await this.store.league(leagueId); if (!knownLeague) throw new Error('League metadata is unavailable');
      const season = 'league_id' in knownLeague ? knownLeague.season : knownLeague.season;
      if (rawLeague) write.league = this.league(rawLeague, synchronizedAt);
      const [users, rosters, matchups, transactions, picks, players] = await Promise.all([
        obtain('users', `users:${leagueId}`, () => this.client.leagueUsers(leagueId)),
        obtain('rosters', `rosters:${leagueId}`, () => this.client.rosters(leagueId)),
        obtain('matchups', `matchups:${leagueId}:${season}:${week}`, () => this.client.matchups(leagueId, week)),
        obtain('transactions', `transactions:${leagueId}:${season}:${week}`, () => this.client.transactions(leagueId, week)),
        obtain('draftPicks', `draftPicks:${leagueId}`, () => this.client.tradedPicks(leagueId)),
        obtain('players', 'players:nfl', () => this.client.players())
      ]);
      if (users) write.users = users.map(value => ({ id: value.user_id, username: value.username, displayName: value.display_name, avatarId: value.avatar, ...source(synchronizedAt) } satisfies User));
      if (rosters) write.rosters = rosters.map(value => this.roster(leagueId, value, synchronizedAt));
      if (matchups) write.matchups = matchups.map(value => this.matchup(leagueId, season, week, value, synchronizedAt));
      if (transactions) write.transactions = transactions.map(value => this.transaction(leagueId, week, value, synchronizedAt));
      if (picks) write.draftPicks = picks.map((value, index) => this.pick(leagueId, value, index, synchronizedAt));
      if (players) write.players = Object.entries(players).map(([id, value]) => this.player(id, value, synchronizedAt));
      if (write.rosters || write.matchups) {
        const snapshotRosters = write.rosters ?? await this.store.rosters(leagueId); const snapshotMatchups = write.matchups ?? [];
        const id = `${leagueId}:${season}:${week}:${synchronizedAt}`;
        write.weeklySnapshot = { id, leagueId, season, week, rosterIds: snapshotRosters.map(v => v.id), matchupIds: snapshotMatchups.map(v => v.id), rosters: snapshotRosters, matchups: snapshotMatchups, ...source(synchronizedAt) };
      }
      await this.store.applySync(write); await this.store.recordSync(leagueId, 'success', synchronizedAt, Date.now() - started);
      this.logger.info({ leagueId, durationMs: Date.now() - started, refreshed, synchronizedAt }, 'league synchronization completed');
      return { leagueId, synchronizedAt, refreshed, ...(write.weeklySnapshot ? { snapshotId: write.weeklySnapshot.id } : {}) };
    } catch (error) {
      const category = error instanceof SleeperApiError ? error.category : 'internal'; await this.store.recordSync(leagueId, 'failed', synchronizedAt, Date.now() - started, category);
      this.logger.error({ leagueId, durationMs: Date.now() - started, category }, 'league synchronization failed'); throw error;
    }
  }
  private league(v: SleeperLeague, at: string): League { return { id: v.league_id, name: v.name, season: v.season, status: v.status, previousLeagueId: v.previous_league_id ?? null, totalRosters: v.total_rosters ?? null, scoringSettings: Object.entries(v.scoring_settings ?? {}).map(([key, points]) => ({ key, points })), rosterPositions: v.roster_positions.map((position, slot) => ({ position, slot })), ...source(at) }; }
  private roster(leagueId: string, v: SleeperRoster, at: string): Roster { return { id: `${leagueId}:${v.roster_id}`, leagueId, rosterId: v.roster_id, ownerId: v.owner_id, coOwnerIds: v.co_owners ?? [], playerIds: v.players ?? [], starterIds: v.starters ?? [], reserveIds: v.reserve ?? [], taxiIds: v.taxi ?? [], settings: Object.fromEntries(Object.entries(v.settings).filter((entry): entry is [string, number] => typeof entry[1] === 'number')), ...source(at) }; }
  private matchup(leagueId: string, season: string, week: number, v: SleeperMatchup, at: string): Matchup { return { id: `${leagueId}:${season}:${week}:${v.roster_id}`, leagueId, season, week, matchupId: v.matchup_id, rosterId: v.roster_id, points: v.points, customPoints: v.custom_points ?? null, playerIds: v.players, starterIds: v.starters, playerPoints: v.players_points ?? {}, ...source(at) }; }
  private transaction(leagueId: string, week: number, v: SleeperTransaction, at: string): Transaction { return { id: v.transaction_id, leagueId, week, type: v.type, status: v.status, rosterIds: v.roster_ids, adds: v.adds ?? {}, drops: v.drops ?? {}, draftPicks: v.draft_picks.map(p => ({ season: p.season, round: p.round, rosterId: p.roster_id, previousOwnerId: p.previous_owner_id ?? null, ownerId: p.owner_id })), waiverBudget: v.waiver_budget ?? [], ...source(at, v.status_updated ?? v.created) }; }
  private pick(leagueId: string, v: SleeperDraftPick, index: number, at: string): TradedDraftPick { return { id: `${leagueId}:${v.season}:${v.round}:${v.roster_id}:${index}`, leagueId, season: v.season, round: v.round, rosterId: v.roster_id, previousOwnerId: v.previous_owner_id ?? null, ownerId: v.owner_id, ...source(at) }; }
  private player(id: string, v: SleeperPlayer, at: string): NflPlayer { return { id, firstName: v.first_name ?? null, lastName: v.last_name ?? null, fullName: v.full_name ?? ([v.first_name, v.last_name].filter(Boolean).join(' ') || id), team: v.team ?? null, position: v.position ?? null, fantasyPositions: v.fantasy_positions ?? [], status: v.status ?? null, ...source(at) }; }
}
