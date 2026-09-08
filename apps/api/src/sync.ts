import type { DraftPick, League, Matchup, NflPlayer, Roster, Transaction, User, WeeklySnapshot } from '@sleeper/domain';
import { SleeperClient, SleeperClientError, type SleeperLeague, type SleeperTransaction } from '@sleeper/sleeper-client';
import type { JsonStore } from './store.js';
export const REFRESH_POLICY = { leagueMs: 15 * 60_000, weeklyMs: 5 * 60_000, playersMs: 24 * 60 * 60_000 } as const;
export interface SyncLogger { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void; }
const logger: SyncLogger = { info: (fields, message) => console.info(message, fields), error: (fields, message) => console.error(message, fields) };
const sourceTime = (value?: string | number): string | null => value == null ? null : new Date(typeof value === 'number' ? value : value).toISOString();
const rosterKey = (leagueId: string, rosterId: number) => `${leagueId}:${rosterId}`;
const sourceLeagueTime = (league: SleeperLeague) => sourceTime(league.metadata?.updated_at);
const transactionTime = (transactions: SleeperTransaction[]) => transactions.reduce<string | null>((latest, item) => { const value = sourceTime(item.created); return value && (!latest || value > latest) ? value : latest; }, null);
export class LeagueSyncService {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly store: JsonStore, private readonly client = new SleeperClient(), private readonly log: SyncLogger = logger, private readonly now = () => new Date()) {}
  sync(leagueId: string, week?: number): Promise<void> { const active = this.locks.get(leagueId); if (active) return active; const job = this.run(leagueId, week).finally(() => this.locks.delete(leagueId)); this.locks.set(leagueId, job); return job; }
  private async run(leagueId: string, requestedWeek?: number) {
    const started = Date.now(); const syncedAt = this.now().toISOString();
    try {
      const existing = await this.store.data(); const leagueRaw = await this.client.league(leagueId); const week = requestedWeek ?? leagueRaw.settings?.leg ?? 1;
      const [rostersRaw, matchupsRaw, transactionsRaw, picksRaw] = await Promise.all([this.client.rosters(leagueId), this.client.matchups(leagueId, week), this.client.transactions(leagueId, week), this.client.tradedPicks(leagueId)]);
      const ownerIds = [...new Set(rostersRaw.flatMap(item => item.owner_id ? [item.owner_id] : []))];
      const usersRaw = await Promise.all(ownerIds.map(id => this.client.userById(id)));
      const stalePlayers = !existing.freshness.players || this.now().getTime() - Date.parse(existing.freshness.players) >= REFRESH_POLICY.playersMs;
      const playersRaw = stalePlayers ? await this.client.nflPlayers() : undefined;
      const meta = { syncedAt, sourceUpdatedAt: sourceLeagueTime(leagueRaw) };
      const league: League = { id: leagueRaw.league_id, name: leagueRaw.name, season: leagueRaw.season, seasonType: leagueRaw.season_type ?? 'regular', status: leagueRaw.status, totalRosters: leagueRaw.total_rosters ?? rostersRaw.length, scoringSettings: leagueRaw.scoring_settings ?? {}, rosterPositions: leagueRaw.roster_positions, ...meta };
      const users: User[] = usersRaw.map(item => ({ id: item.user_id, username: item.username, displayName: item.display_name, avatarId: item.avatar, sourceUpdatedAt: sourceTime(item.metadata?.updated_at), syncedAt }));
      const rosters: Roster[] = rostersRaw.map(item => ({ id: rosterKey(leagueId, item.roster_id), leagueId, ownerId: item.owner_id, playerIds: item.players ?? [], starterIds: item.starters ?? [], settings: item.settings, ...meta }));
      const matchups: Matchup[] = matchupsRaw.map(item => ({ id: `${leagueId}:${week}:${item.roster_id}`, leagueId, week, rosterId: rosterKey(leagueId, item.roster_id), matchupId: item.matchup_id, playerIds: item.players ?? [], starterIds: item.starters ?? [], points: item.points, customPoints: item.custom_points ?? null, sourceUpdatedAt: transactionTime(transactionsRaw), syncedAt }));
      const transactions: Transaction[] = transactionsRaw.map(item => ({ id: item.transaction_id, leagueId, week, type: item.type, status: item.status, rosterIds: item.roster_ids.map(id => rosterKey(leagueId, id)), adds: item.adds ?? {}, drops: item.drops ?? {}, waiverBudget: item.waiver_budget ?? [], sourceUpdatedAt: sourceTime(item.created), syncedAt }));
      const draftPicks: DraftPick[] = picksRaw.map(item => ({ id: `${leagueId}:${item.season}:${item.round}:${item.roster_id}`, leagueId, season: item.season, round: item.round, rosterId: rosterKey(leagueId, item.roster_id), previousOwnerId: rosterKey(leagueId, item.previous_owner_id), ownerId: rosterKey(leagueId, item.owner_id), ...meta }));
      const players: NflPlayer[] | undefined = playersRaw && Object.entries(playersRaw).map(([id, item]) => ({ id, firstName: item.first_name ?? '', lastName: item.last_name ?? '', fullName: item.full_name ?? [item.first_name, item.last_name].filter(Boolean).join(' '), team: item.team ?? null, position: item.position ?? null, fantasyPositions: item.fantasy_positions ?? [], active: item.active ?? false, sourceUpdatedAt: null, syncedAt }));
      const weeklySnapshots: WeeklySnapshot[] = rosters.map(roster => ({ id: `${leagueId}:${league.season}:${week}:${roster.id}`, leagueId, season: league.season, week, roster, matchups: matchups.filter(item => item.rosterId === roster.id), sourceUpdatedAt: transactionTime(transactionsRaw) ?? meta.sourceUpdatedAt, syncedAt }));
      await this.store.persistSync({ users, league, players, rosters, matchups, transactions, draftPicks, weeklySnapshots, freshness: { [`league:${leagueId}`]: syncedAt, [`league:${leagueId}:week:${week}`]: syncedAt, ...(players ? { players: syncedAt } : {}) } }, { leagueId, syncedAt, status: 'success', durationMs: Date.now() - started });
      this.log.info({ leagueId, week, durationMs: Date.now() - started, playerMetadataRefreshed: Boolean(players) }, 'league synchronization completed');
    } catch (error) {
      const category = error instanceof SleeperClientError ? error.kind : 'internal'; await this.store.recordFailure({ leagueId, syncedAt, status: 'failed', category, durationMs: Date.now() - started });
      this.log.error({ leagueId, category, durationMs: Date.now() - started }, 'league synchronization failed'); throw error;
    }
  }
}
