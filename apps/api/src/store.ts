import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scoringSnapshotId } from '@sleeper/domain';
import type { League, LeagueSnapshot, Matchup, NflPlayer, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';
import type {
  ApplicationSession, ApplicationUser, ForecastSnapshotRecord, LeagueConnection,
  LeagueScoringSnapshotRecord, PlayerAlias, PlayerMetadataState, RecommendationOutcome,
  RecommendationQuery, RecommendationRecord, RosterHistoryQuery, RosterObservation, SessionRevocation,
  SleeperAccountLink, SyncAttempt, SyncLease, SyncRunQuery, SyncRunRecord, SyncStatus, SyncWrite,
  WeeklySnapshotQuery,
} from './storage/records.js';
import type { HuddleRepository } from './storage/repositories.js';

/**
 * The local development adapter.
 *
 * It implements the whole `HuddleRepository` contract over one JSON document: snapshots keyed by
 * league, the connection set, the shared player directory, observations, recommendations and the
 * worker's leases. Writes are serialized through one queue and land by temporary file plus atomic
 * rename, so a reader sees either the previous document or the next one and never a partial write.
 *
 * That is genuinely atomic *within one process*, which is exactly as far as a file goes: two processes
 * sharing one document can still interleave between read and rename. So this adapter is the local
 * profile, `configure.ts` refuses it in a multi-instance production deployment, and the PostgreSQL
 * schema in `apps/api/migrations` is what a scaled deployment runs instead.
 */

// The stored records are the repository contract rather than this file's own types; they are
// re-exported here so existing imports keep working.
export type {
  ApplicationSession, ApplicationUser, ForecastSnapshotRecord, LeagueConnection,
  LeagueScoringSnapshotRecord, PlayerAlias, PlayerMetadataState, RecommendationExplanation,
  RecommendationOutcome, RecommendationQuery, RecommendationRecord, RosterHistoryQuery,
  RosterObservation, SessionRevocation, SleeperAccountLink, SyncAttempt, SyncLease, SyncRunQuery,
  SyncRunRecord, SyncStatus, SyncWrite, WeeklySnapshotQuery,
} from './storage/records.js';

/**
 * One entry of the synchronization log.
 *
 * The first five fields are the shape this store has always written; the rest arrived with
 * `recordSyncRun`, and are optional so an existing document keeps reading. Unlike the PostgreSQL
 * `sync_run` table, which keeps per-league history, this log is globally bounded: the point of the
 * local profile is a file that cannot grow without limit.
 */
export interface StoredSyncRun {
  leagueId: string | null;
  /** The run's synchronization timestamp, which is when it started. */
  syncedAt: string;
  status: SyncStatus;
  category?: string; durationMs?: number;
  id?: string; kind?: SyncRunRecord['kind']; season?: string | null; week?: number | null;
  finishedAt?: string; refreshed?: string[]; nextAttemptAt?: string; workerId?: string;
}

/**
 * Newest forecast first.
 *
 * The source's own timestamp decides, because that is what the feed is current *for*. Two ingestions
 * of the same publication are separated by when we observed them, so "the newest for this week" is
 * never an arbitrary choice between two rows.
 */
const byRecency = (a: ForecastSnapshotRecord, b: ForecastSnapshotRecord) =>
  b.sourceUpdatedAt.localeCompare(a.sourceUpdatedAt) || b.ingestedAt.localeCompare(a.ingestedAt);

/** An entry as the repository reports it, including the fields older entries did not record. */
const asSyncRun = (entry: StoredSyncRun): SyncRunRecord => ({
  id: entry.id ?? `${entry.leagueId ?? 'global'}:${entry.syncedAt}`,
  leagueId: entry.leagueId, kind: entry.kind ?? 'league', status: entry.status,
  ...(entry.category ? { category: entry.category } : {}),
  season: entry.season ?? null, week: entry.week ?? null,
  startedAt: entry.syncedAt,
  finishedAt: entry.finishedAt ?? new Date(Date.parse(entry.syncedAt) + (entry.durationMs ?? 0)).toISOString(),
  durationMs: entry.durationMs ?? 0, refreshed: entry.refreshed ?? [],
  ...(entry.nextAttemptAt ? { nextAttemptAt: entry.nextAttemptAt } : {}),
  ...(entry.workerId ? { workerId: entry.workerId } : {}),
});

export interface StoreShape {
  snapshots: Record<string, LeagueSnapshot>;
  leagues: Record<string, League>; users: Record<string, User>; players: Record<string, NflPlayer>;
  rosters: Record<string, Roster>; matchups: Record<string, Matchup>; transactions: Record<string, Transaction>;
  draftPicks: Record<string, TradedDraftPick>; weeklySnapshots: WeeklySnapshot[];
  freshness: Record<string, string>;
  applicationUsers: Record<string, ApplicationUser>; sessions: Record<string, ApplicationSession>;
  syncLog: StoredSyncRun[];
  leagueConnections: Record<string, LeagueConnection>; leases: Record<string, SyncLease>;
  playerMetadata?: PlayerMetadataState;
  /** Scoring observations per league, newest last. The `league_scoring_snapshot` table in one field. */
  scoringSnapshots: Record<string, LeagueScoringSnapshotRecord[]>;
  playerAliases: PlayerAlias[];
  rosterHistory: RosterObservation[];
  forecastSnapshots: ForecastSnapshotRecord[];
  recommendations: Record<string, RecommendationRecord>;
  recommendationOutcomes: RecommendationOutcome[];
}

function revoke(session: ApplicationSession | undefined, reason: SessionRevocation, at: string) { if (!session || session.revokedAt) return; session.revokedAt = at; session.revokedReason = reason; }
const empty = (): StoreShape => ({ snapshots: {}, leagues: {}, users: {}, players: {}, rosters: {}, matchups: {}, transactions: {}, draftPicks: {}, weeklySnapshots: [], freshness: {}, applicationUsers: {}, sessions: {}, syncLog: [], leagueConnections: {}, leases: {}, scoringSnapshots: {}, playerAliases: [], rosterHistory: [], forecastSnapshots: [], recommendations: {}, recommendationOutcomes: [] });
export class JsonStore implements HuddleRepository {
  readonly adapter = 'json' as const;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<StoreShape> {
    try { return { ...empty(), ...JSON.parse(await readFile(this.path, 'utf8')) as StoreShape }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return empty(); }
  }
  private write(mutator: (data: StoreShape) => void): Promise<void> {
    const operation = this.writes.then(async () => { const data = await this.read(); mutator(data); await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, this.path); });
    this.writes = operation.catch(() => undefined); return operation;
  }
  async snapshot(id: string) { return (await this.read()).snapshots[id]; }
  async save(snapshot: LeagueSnapshot) { await this.write(data => { data.snapshots[snapshot.leagueId] = snapshot; data.syncLog.unshift({ leagueId: snapshot.leagueId, syncedAt: snapshot.lastSyncedAt, status: 'success' }); data.syncLog = data.syncLog.slice(0, 100); }); }
  async resourceSyncedAt(key: string) { return (await this.read()).freshness[key]; }
  async league(id: string) { return (await this.read()).leagues[id]; }
  async applicationUserByLogin(login: string) { return Object.values((await this.read()).applicationUsers).find(user => user.login === login); }
  async applicationUser(id: string) { return (await this.read()).applicationUsers[id]; }
  async saveApplicationUser(user: ApplicationUser) { await this.write(data => { data.applicationUsers[user.id] = user; }); }
  async session(idHash: string) { return (await this.read()).sessions[idHash]; }
  async saveSession(session: ApplicationSession) { await this.write(data => { data.sessions[session.idHash] = session; }); }
  async revokeSession(idHash: string, reason: SessionRevocation = 'logout', at = new Date().toISOString()) { await this.write(data => { revoke(data.sessions[idHash], reason, at); }); }
  /** Logout and theft detection act on the whole rotation family, so a superseded predecessor cannot be replayed. */
  async revokeSessionFamily(familyId: string, reason: SessionRevocation, at = new Date().toISOString()) { await this.write(data => { for (const session of Object.values(data.sessions)) if (session.familyId === familyId) revoke(session, reason, at); }); }
  async revokeUserSessions(userId: string, reason: SessionRevocation = 'logout-all', at = new Date().toISOString()) { await this.write(data => { for (const session of Object.values(data.sessions)) if (session.userId === userId) revoke(session, reason, at); }); }
  /** Rotation is one write so a crash can never leave both the predecessor and its successor usable. */
  async rotateSession(previousIdHash: string, next: ApplicationSession, at = new Date().toISOString()) {
    await this.write(data => { const previous = data.sessions[previousIdHash]; if (previous) previous.supersededAt = at; data.sessions[next.idHash] = next; });
  }
  /** Extends the sliding idle deadline; callers throttle this so a busy client does not write on every request. */
  async touchSession(idHash: string, expiresAt: string, seenAt: string) {
    await this.write(data => { const session = data.sessions[idHash]; if (!session || session.revokedAt) return; session.expiresAt = expiresAt; session.lastSeenAt = seenAt; });
  }
  async addSessionCsrfHash(idHash: string, csrfHash: string, keep = 5) {
    await this.write(data => { const session = data.sessions[idHash]; if (!session || session.revokedAt) return; session.csrfHashes = [csrfHash, ...session.csrfHashes.filter(value => value !== csrfHash)].slice(0, keep); });
  }
  /** Sessions are dropped once they can no longer authenticate anything, keeping the store from growing without bound. */
  async pruneSessions(now = Date.now(), retentionMs = 7 * 24 * 60 * 60_000) {
    let removed = 0;
    await this.write(data => {
      for (const [idHash, session] of Object.entries(data.sessions)) {
        const revokedAt = session.revokedAt ? Date.parse(session.revokedAt) : undefined;
        const dead = Math.max(Date.parse(session.absoluteExpiresAt) || 0, Date.parse(session.expiresAt) || 0, revokedAt ?? 0);
        if (now - dead > retentionMs) { delete data.sessions[idHash]; removed++; }
      }
    });
    return removed;
  }
  async rosters(leagueId: string) { return Object.values((await this.read()).rosters).filter(value => value.leagueId === leagueId); }
  /** The whole synchronized player directory; projection ingestion resolves identities against it. */
  async allPlayers() { return Object.values((await this.read()).players); }
  async playerDirectory() {
    const data = await this.read();
    // Upgrade an existing store without discarding its last successful observation. The old
    // directory is due immediately so it passes the new ingestion validation on first refresh.
    const legacyAt = data.freshness['players:nfl'];
    const metadata = data.playerMetadata ?? (legacyAt ? {
      synchronizedAt: legacyAt, lastAttemptedAt: legacyAt, nextAttemptAt: legacyAt, lastError: null,
    } : undefined);
    return { players: data.players, metadata };
  }
  /** Publish the validated directory and its freshness together; failures only update attempt state. */
  async savePlayerDirectory(metadata: PlayerMetadataState, players?: NflPlayer[]) {
    await this.write(data => {
      if (players) {
        data.players = Object.fromEntries(players.map(player => [player.id, player]));
        data.freshness['players:nfl'] = metadata.synchronizedAt!;
      }
      data.playerMetadata = metadata;
    });
  }
  /** Every connected league, so a process-wide job can ask which of them have live scoring. */
  async allLeagues() { return Object.values((await this.read()).leagues); }

  // --- Connected leagues -------------------------------------------------------------------------
  async leagueConnections() { return Object.values((await this.read()).leagueConnections); }
  async leagueConnection(leagueId: string) { return (await this.read()).leagueConnections[leagueId]; }
  async activeLeagueConnections() { return (await this.leagueConnections()).filter(connection => connection.status === 'active'); }
  /**
   * Registers a league as connected, or revives one that was archived for being unlinked.
   *
   * A record archived by the retention policy stays archived: re-linking a finished 2024 league is a
   * request to keep its data, not a request to start synchronizing a season that cannot change.
   */
  async connectLeague(leagueId: string, options: { demo?: boolean; season?: string | null; week?: number | null; at?: string } = {}) {
    const at = options.at ?? new Date().toISOString();
    let result!: LeagueConnection;
    await this.write(data => {
      const existing = data.leagueConnections[leagueId];
      const connection: LeagueConnection = existing
        ? { ...existing, linked: true, updatedAt: at }
        : { leagueId, demo: false, status: 'active', linked: true, season: null, week: null, createdAt: at, updatedAt: at, consecutiveFailures: 0 };
      if (!existing || (connection.status === 'archived' && connection.archivedReason === 'unlinked')) {
        connection.status = 'active'; delete connection.archivedAt; delete connection.archivedReason;
      }
      if (options.demo !== undefined) connection.demo = options.demo;
      if (options.season) connection.season = options.season;
      if (typeof options.week === 'number') connection.week = options.week;
      result = data.leagueConnections[leagueId] = connection;
    });
    return result;
  }
  async updateLeagueConnection(leagueId: string, patch: Partial<LeagueConnection>, at = new Date().toISOString()) {
    await this.write(data => { const connection = data.leagueConnections[leagueId]; if (connection) Object.assign(connection, patch, { updatedAt: at }); });
  }
  async archiveLeagueConnection(leagueId: string, reason: string, at = new Date().toISOString()) {
    await this.write(data => {
      const connection = data.leagueConnections[leagueId];
      if (!connection || connection.status === 'archived') return;
      Object.assign(connection, { status: 'archived', archivedAt: at, archivedReason: reason, updatedAt: at, nextAttemptAt: undefined });
    });
  }
  /**
   * Brings the connection set in line with the leagues the application accounts actually link.
   *
   * Run before every sweep rather than only at connect time, so an account edited by another instance,
   * or a store restored from a backup, converges without an operator having to reconcile it by hand.
   */
  async reconcileLeagueConnections(at = new Date().toISOString(), demoLeagueIds: readonly string[] = ['demo']) {
    let result: LeagueConnection[] = [];
    await this.write(data => {
      const linked = new Set(Object.values(data.applicationUsers).flatMap(user => user.sleeperLeagueIds));
      for (const leagueId of linked) {
        const existing = data.leagueConnections[leagueId];
        const demo = demoLeagueIds.includes(leagueId);
        if (!existing) {
          data.leagueConnections[leagueId] = { leagueId, demo, status: 'active', linked: true, season: data.leagues[leagueId]?.season ?? null, week: null, createdAt: at, updatedAt: at, consecutiveFailures: 0 };
          continue;
        }
        const revive = existing.status === 'archived' && existing.archivedReason === 'unlinked';
        Object.assign(existing, { linked: true, demo, updatedAt: at, ...(revive ? { status: 'active', archivedAt: undefined, archivedReason: undefined } : {}) });
      }
      for (const connection of Object.values(data.leagueConnections)) {
        if (linked.has(connection.leagueId)) continue;
        Object.assign(connection, { linked: false, updatedAt: at });
        if (connection.status === 'active') Object.assign(connection, { status: 'archived', archivedAt: at, archivedReason: 'unlinked', nextAttemptAt: undefined });
      }
      result = Object.values(data.leagueConnections);
    });
    return result;
  }
  /**
   * Records what one attempt did against its connection.
   *
   * A failure never clears `lastSyncedAt` or any stored league data: the last good snapshot is what the
   * dashboard keeps serving while Sleeper is unavailable, and the failure category plus `nextAttemptAt`
   * are what say why it is not newer.
   */
  async recordLeagueSyncAttempt(leagueId: string, attempt: SyncAttempt) {
    await this.write(data => {
      const connection = data.leagueConnections[leagueId] ?? (data.leagueConnections[leagueId] = { leagueId, demo: false, status: 'active', linked: false, season: null, week: null, createdAt: attempt.at, updatedAt: attempt.at, consecutiveFailures: 0 });
      connection.updatedAt = attempt.at;
      connection.lastAttemptedAt = attempt.at;
      connection.lastStatus = attempt.status;
      connection.lastDurationMs = attempt.durationMs;
      connection.lastCategory = attempt.status === 'failed' ? attempt.category ?? 'internal' : undefined;
      connection.nextAttemptAt = attempt.nextAttemptAt;
      connection.consecutiveFailures = attempt.consecutiveFailures ?? (attempt.status === 'failed' ? connection.consecutiveFailures + 1 : 0);
      if (attempt.season) connection.season = attempt.season;
      if (typeof attempt.week === 'number') connection.week = attempt.week;
      if (attempt.resourceFreshness) connection.resourceFreshness = attempt.resourceFreshness;
      if (attempt.status === 'success') { connection.lastSyncedAt = attempt.at; connection.lastRefreshed = attempt.refreshed ?? []; }
    });
  }
  /** Per-resource synchronization timestamps for one league, plus the shared player directory. */
  async resourceFreshness(leagueId: string) {
    const { freshness } = await this.read();
    return Object.fromEntries(Object.entries(freshness).filter(([key]) => key.split(':')[1] === leagueId || key === 'players:nfl'));
  }
  /**
   * Deletes one league's stored data and its connection.
   *
   * Only ever called for a connection the retention policy has already archived and no account links;
   * the shared player directory is deliberately untouched, because it belongs to every league.
   */
  async pruneLeague(leagueId: string) {
    let removed = 0;
    await this.write(data => {
      const drop = <T>(target: Record<string, T>, matches: (value: T) => boolean) => { for (const [key, value] of Object.entries(target)) if (matches(value)) { delete target[key]; removed++; } };
      delete data.leagues[leagueId]; delete data.snapshots[leagueId]; delete data.leagueConnections[leagueId];
      drop(data.rosters, value => value.leagueId === leagueId); drop(data.matchups, value => value.leagueId === leagueId);
      drop(data.transactions, value => value.leagueId === leagueId); drop(data.draftPicks, value => value.leagueId === leagueId);
      data.weeklySnapshots = data.weeklySnapshots.filter(snapshot => snapshot.leagueId !== leagueId);
      const history = data.rosterHistory.length;
      data.rosterHistory = data.rosterHistory.filter(observation => observation.leagueId !== leagueId);
      const advice = new Set(Object.values(data.recommendations).filter(value => value.leagueId === leagueId).map(value => value.id));
      for (const id of advice) delete data.recommendations[id];
      // Outcomes follow the advice they grade, as the schema's cascades do.
      data.recommendationOutcomes = data.recommendationOutcomes.filter(outcome => !advice.has(outcome.recommendationId));
      removed += history - data.rosterHistory.length + advice.size + (data.scoringSnapshots[leagueId]?.length ?? 0);
      delete data.scoringSnapshots[leagueId];
      for (const key of Object.keys(data.freshness)) if (key.split(':')[1] === leagueId) delete data.freshness[key];
      data.syncLog = data.syncLog.filter(entry => entry.leagueId !== leagueId);
    });
    return removed;
  }

  // --- Leases ------------------------------------------------------------------------------------
  /**
   * Takes the lease on `key`, or returns null when another owner still holds a live one.
   *
   * Read and write happen inside one queued store operation, so within a process this is atomic. Two
   * processes sharing one JSON file can still interleave; that profile is single-instance by design,
   * and a horizontally scaled deployment supplies a lock backed by its database instead. See
   * docs/league-sync.md.
   */
  async acquireLease(key: string, owner: string, ttlMs: number, now = new Date()) {
    let lease: SyncLease | null = null;
    await this.write(data => {
      const held = data.leases[key];
      const live = held && Date.parse(held.expiresAt) > now.getTime();
      if (live && held.owner !== owner) return;
      lease = data.leases[key] = { key, owner, acquiredAt: live && held.owner === owner ? held.acquiredAt : now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    });
    return lease as SyncLease | null;
  }
  async releaseLease(key: string, owner: string) {
    await this.write(data => { if (data.leases[key]?.owner === owner) delete data.leases[key]; });
  }
  async lease(key: string) { return (await this.read()).leases[key]; }
  /** One atomic file read: engines must never assemble a dashboard from separate store reads. */
  async dashboardContext(leagueId: string, week: number, now = Date.now()) {
    const data = await this.read();
    const league = data.leagues[leagueId];
    const rosters = Object.values(data.rosters).filter(r => r.leagueId === leagueId);
    const owners = new Set(rosters.flatMap(r => [r.ownerId, ...r.coOwnerIds]));
    const pickAge = now - Date.parse(data.freshness[`draftPicks:${leagueId}`]);
    return {
      league, rosters, players: Object.values(data.players),
      users: Object.values(data.users).filter(u => owners.has(u.id)),
      matchups: Object.values(data.matchups).filter(m => m.leagueId === leagueId && m.season === league?.season && m.week === week),
      transactions: Object.values(data.transactions).filter(t => t.leagueId === leagueId && t.week === week),
      tradedPicks: Number.isFinite(pickAge) && pickAge >= -5 * 60_000 && pickAge <= 10 * 60_000
        ? Object.values(data.draftPicks).filter(p => p.leagueId === leagueId) : undefined,
      freshness: Object.fromEntries(Object.entries(data.freshness).filter(([key]) => key.split(':')[1] === leagueId || key === 'players:nfl')),
    };
  }
  async waiverContext(leagueId: string) {
    const data = await this.read();
    return { league: data.leagues[leagueId], rosters: Object.values(data.rosters).filter(r => r.leagueId === leagueId), players: Object.values(data.players) };
  }
  /** Lineup analysis additionally needs the week's matchups to identify the scheduled opponent. */
  async lineupContext(leagueId: string, season: string, week: number) {
    const data = await this.read();
    return {
      league: data.leagues[leagueId], rosters: Object.values(data.rosters).filter(r => r.leagueId === leagueId),
      players: Object.values(data.players), users: Object.values(data.users),
      matchups: Object.values(data.matchups).filter(m => m.leagueId === leagueId && m.season === season && m.week === week),
    };
  }
  async tradeContext(leagueId: string) {
    const data = await this.read();
    const pickAge = Date.now() - Date.parse(data.freshness[`draftPicks:${leagueId}`]);
    return { league: data.leagues[leagueId], rosters: Object.values(data.rosters).filter(r => r.leagueId === leagueId), players: Object.values(data.players), users: Object.values(data.users), tradedPicks: Number.isFinite(pickAge) && pickAge >= -5 * 60_000 && pickAge <= 10 * 60_000 ? Object.values(data.draftPicks).filter(p => p.leagueId === leagueId) : undefined };
  }
  async applySync(write: SyncWrite) { await this.write(data => {
    const upsert = <T extends { id: string }>(target: Record<string, T>, values?: T[]) => { for (const value of values ?? []) target[value.id] = value; };
    if (write.league) {
      data.leagues[write.league.id] = write.league;
      // The scoring observation is recorded with the league it belongs to, in this same write. A
      // ranking cites the observation by id, and an observation that could be written separately
      // could also be missed — leaving a citation pointing at nothing.
      const scoring = write.league.scoring;
      if (scoring) {
        const id = scoringSnapshotId(scoring);
        const history = data.scoringSnapshots[write.league.id] ??= [];
        if (!history.some(value => value.id === id)) history.push({
          id, leagueId: write.league.id, kind: scoring.kind, observedAt: scoring.synchronizedAt,
          lastAttemptedAt: scoring.lastAttemptedAt, settings: scoring.settings, rawSettings: scoring.rawSettings,
          issues: scoring.issues, recordedAt: new Date().toISOString(),
        });
      }
    }
    // Transfers are an authoritative snapshot: returned/native picks must not retain old owners.
    if (write.replaceDraftPicksForLeague && write.draftPicks) for (const [id, pick] of Object.entries(data.draftPicks)) if (pick.leagueId === write.replaceDraftPicksForLeague) delete data.draftPicks[id];
    upsert(data.users, write.users); upsert(data.players, write.players); upsert(data.rosters, write.rosters); upsert(data.matchups, write.matchups); upsert(data.transactions, write.transactions); upsert(data.draftPicks, write.draftPicks);
    // Weekly observations are append-only; a caller-generated id makes retrying the same observation idempotent.
    if (write.weeklySnapshot && !data.weeklySnapshots.some(snapshot => snapshot.id === write.weeklySnapshot!.id)) data.weeklySnapshots.push(write.weeklySnapshot);
    for (const observation of write.rosterObservations ?? []) {
      if (!data.rosterHistory.some(value => value.id === observation.id)) data.rosterHistory.push(observation);
    }
    Object.assign(data.freshness, write.freshness);
  }); }
  // --- Sleeper account associations ---------------------------------------------------------------
  /**
   * The Sleeper account an application account claims.
   *
   * This adapter keeps the association on the account record; the schema keeps it in `sleeper_account`
   * and `app_user_league`. Both answer the same three questions: what this account claims, which
   * accounts link a league, and which leagues are linked at all — the last being what reconciliation
   * derives the synchronization schedule from.
   */
  async sleeperAccount(userId: string): Promise<SleeperAccountLink | undefined> {
    const user = (await this.read()).applicationUsers[userId];
    if (!user?.sleeperUserId) return undefined;
    return {
      userId, sleeperUserId: user.sleeperUserId, sleeperUsername: user.sleeperUsername ?? '',
      leagueIds: [...user.sleeperLeagueIds], linkedAt: user.sleeperLinkedAt ?? user.createdAt,
    };
  }
  async linkSleeperAccount(link: SleeperAccountLink) {
    await this.write(data => {
      const user = data.applicationUsers[link.userId];
      if (!user) throw new Error(`Cannot link a Sleeper account to unknown application account ${link.userId}.`);
      Object.assign(user, {
        sleeperUserId: link.sleeperUserId, sleeperUsername: link.sleeperUsername,
        sleeperLeagueIds: [...new Set(link.leagueIds)], sleeperLinkedAt: link.linkedAt,
      });
    });
  }
  async unlinkSleeperAccount(userId: string) {
    await this.write(data => {
      const user = data.applicationUsers[userId];
      if (!user) return;
      delete user.sleeperUserId; delete user.sleeperUsername; delete user.sleeperLinkedAt;
      user.sleeperLeagueIds = [];
    });
  }
  /** Retention deletes a league's data only when this is empty. */
  async accountsLinkingLeague(leagueId: string) {
    return Object.values((await this.read()).applicationUsers).filter(user => user.sleeperLeagueIds.includes(leagueId)).map(user => user.id);
  }
  async linkedLeagueIds() {
    return [...new Set(Object.values((await this.read()).applicationUsers).flatMap(user => user.sleeperLeagueIds))];
  }

  // --- Scoring observations -------------------------------------------------------------------------
  /** Newest first. Recorded by `applySync`, never separately: see the comment there. */
  async scoringSnapshots(leagueId: string) { return [...((await this.read()).scoringSnapshots[leagueId] ?? [])].reverse(); }
  async scoringSnapshot(leagueId: string, id: string) { return (await this.read()).scoringSnapshots[leagueId]?.find(value => value.id === id); }

  // --- Player aliases ---------------------------------------------------------------------------
  /**
   * Replaces one source's aliases.
   *
   * Scoped to a source, so a failed ingestion of one identity map cannot disturb another's. Two
   * different answers for one key is ambiguity, and ambiguity is refused rather than resolved to
   * whichever arrived last — the same rule the identity resolver applies upstream, and the same one
   * the schema's `(source, alias_key)` primary key applies at rest.
   */
  async savePlayerAliases(source: string, aliases: PlayerAlias[]) {
    let stored = 0;
    await this.write(data => {
      const resolved = new Map<string, PlayerAlias>();
      for (const alias of aliases) {
        if (alias.source !== source) throw new Error(`A ${alias.source} alias was supplied to a ${source} replacement.`);
        const existing = resolved.get(alias.aliasKey);
        if (existing && existing.playerId !== alias.playerId) throw new Error(`${source}:${alias.aliasKey} resolves to both ${existing.playerId} and ${alias.playerId}; an ambiguous identity is never stored.`);
        resolved.set(alias.aliasKey, alias);
      }
      data.playerAliases = [...data.playerAliases.filter(value => value.source !== source), ...resolved.values()];
      stored = resolved.size;
    });
    return stored;
  }
  async playerAliases(source?: string) {
    const aliases = (await this.read()).playerAliases;
    return source === undefined ? aliases : aliases.filter(alias => alias.source === source);
  }
  async prunePlayerAliases(source: string, before: string) {
    const cutoff = Date.parse(before);
    let removed = 0;
    await this.write(data => {
      data.playerAliases = data.playerAliases.filter(alias => {
        const stale = alias.source === source && Date.parse(alias.observedAt) < cutoff;
        if (stale) removed++;
        return !stale;
      });
    });
    return removed;
  }

  // --- Roster history ---------------------------------------------------------------------------
  /** Append-only: an observation already recorded at that instant is not written twice. */
  async recordRosterObservations(observations: RosterObservation[]) {
    let added = 0;
    await this.write(data => {
      const seen = new Set(data.rosterHistory.map(value => value.id));
      for (const observation of observations) {
        if (seen.has(observation.id)) continue;
        seen.add(observation.id); data.rosterHistory.push(observation); added++;
      }
    });
    return added;
  }
  async rosterHistory(leagueId: string, query: RosterHistoryQuery = {}) {
    const history = (await this.read()).rosterHistory
      .filter(value => value.leagueId === leagueId
        && (query.season === undefined || value.season === query.season)
        && (query.week === undefined || value.week === query.week)
        && (query.rosterId === undefined || value.rosterId === query.rosterId))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return query.limit === undefined ? history : history.slice(0, query.limit);
  }
  /** Thins to the newest observations per roster per week; anything newer than the cutoff is kept. */
  async pruneRosterHistory(before: string, keepPerWeek = 1) {
    const cutoff = Date.parse(before);
    let removed = 0;
    await this.write(data => {
      const ranks = new Map<string, number>();
      const drop = new Set<string>();
      for (const observation of [...data.rosterHistory].sort((a, b) => b.observedAt.localeCompare(a.observedAt))) {
        const key = `${observation.leagueId}:${observation.rosterId}:${observation.season}:${observation.week}`;
        const rank = (ranks.get(key) ?? 0) + 1;
        ranks.set(key, rank);
        if (rank > keepPerWeek && Date.parse(observation.observedAt) < cutoff) drop.add(observation.id);
      }
      data.rosterHistory = data.rosterHistory.filter(observation => !drop.has(observation.id));
      removed = drop.size;
    });
    return removed;
  }

  // --- Weekly observations ----------------------------------------------------------------------
  async weeklySnapshots(leagueId: string, query: WeeklySnapshotQuery = {}) {
    const snapshots = (await this.read()).weeklySnapshots
      .filter(value => value.leagueId === leagueId
        && (query.season === undefined || value.season === query.season)
        && (query.week === undefined || value.week === query.week))
      .sort((a, b) => b.synchronizedAt.localeCompare(a.synchronizedAt));
    return query.limit === undefined ? snapshots : snapshots.slice(0, query.limit);
  }

  // --- Forecast snapshots -----------------------------------------------------------------------
  /** Append-only, like the schema: re-recording an ingestion already stored is a no-op, not a rewrite. */
  async saveForecastSnapshot(record: ForecastSnapshotRecord) {
    await this.write(data => {
      if (data.forecastSnapshots.some(value => value.id === record.id)) return;
      data.forecastSnapshots.push(record);
    });
  }
  async forecastSnapshot(id: string) { return (await this.read()).forecastSnapshots.find(value => value.id === id); }
  async latestForecastSnapshot(season: string, week: number, source?: string) {
    return (await this.read()).forecastSnapshots
      .filter(value => value.season === season && value.week === week && (source === undefined || value.source === source))
      .sort(byRecency)[0];
  }
  /**
   * Keeps the newest ingestion per week, and never removes one a stored recommendation cites.
   *
   * A citation that outlived what it cites is not a saving; it is advice nobody can check afterwards.
   */
  async pruneForecastSnapshots(before: string, keepPerWeek = 1) {
    const cutoff = Date.parse(before);
    let removed = 0;
    await this.write(data => {
      const cited = new Set(Object.values(data.recommendations).map(value => value.forecastSnapshotId).filter(Boolean));
      const ranks = new Map<string, number>();
      const drop = new Set<string>();
      for (const snapshot of [...data.forecastSnapshots].sort(byRecency)) {
        const key = `${snapshot.source}:${snapshot.season}:${snapshot.week}`;
        const rank = (ranks.get(key) ?? 0) + 1;
        ranks.set(key, rank);
        if (rank > keepPerWeek && Date.parse(snapshot.ingestedAt) < cutoff && !cited.has(snapshot.id)) drop.add(snapshot.id);
      }
      data.forecastSnapshots = data.forecastSnapshots.filter(snapshot => !drop.has(snapshot.id));
      removed = drop.size;
    });
    return removed;
  }

  // --- Recommendations, explanations and outcomes ------------------------------------------------
  /**
   * Stores advice together with its explanations, as one write.
   *
   * The citation checks are the schema's foreign keys, applied here so both adapters refuse the same
   * records: advice may only cite a scoring observation of its own league — points scored under one
   * commissioner's rules can never rank another — and a coverage gap carries no weight, so a category
   * the provider does not model can neither promote nor demote the player it concerns.
   */
  async saveRecommendations(records: RecommendationRecord[]) {
    let stored = 0;
    await this.write(data => {
      for (const record of records) {
        const observations = data.scoringSnapshots[record.leagueId] ?? [];
        if (!observations.some(value => value.id === record.scoringSnapshotId)) {
          throw new Error(`Recommendation ${record.id} cites scoring snapshot ${record.scoringSnapshotId}, which is not an observation of league ${record.leagueId}.`);
        }
        if (record.forecastSnapshotId && !data.forecastSnapshots.some(value => value.id === record.forecastSnapshotId)) {
          throw new Error(`Recommendation ${record.id} cites forecast snapshot ${record.forecastSnapshotId}, which is not stored.`);
        }
        const ordinals = new Set<number>();
        for (const explanation of record.explanations ?? []) {
          if (ordinals.has(explanation.ordinal)) throw new Error(`Recommendation ${record.id} has two explanations at ordinal ${explanation.ordinal}.`);
          ordinals.add(explanation.ordinal);
          if (explanation.kind === 'coverage' && explanation.points) {
            throw new Error(`Recommendation ${record.id} weights a coverage gap with ${explanation.points} points; an unmodelled category contributes exactly zero.`);
          }
        }
        data.recommendations[record.id] = record;
        stored++;
      }
    });
    return stored;
  }
  async recommendations(query: RecommendationQuery) {
    const records = Object.values((await this.read()).recommendations)
      .filter(record => record.leagueId === query.leagueId
        && (query.season === undefined || record.season === query.season)
        && (query.week === undefined || record.week === query.week)
        && (query.rosterId === undefined || record.rosterId === query.rosterId)
        && (query.kind === undefined || record.kind === query.kind)
        && (query.playerId === undefined || record.subjectPlayerId === query.playerId || record.counterpartPlayerId === query.playerId))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return query.limit === undefined ? records : records.slice(0, query.limit);
  }
  /**
   * Records what happened.
   *
   * Append-only: a stat correction is a new observation at a new time, not an edit of the old one. An
   * outcome that says the advice was followed has to say what it scored, or it grades nothing.
   */
  async recordRecommendationOutcome(outcome: RecommendationOutcome) {
    await this.write(data => {
      if (!data.recommendations[outcome.recommendationId]) throw new Error(`Outcome ${outcome.id} refers to unknown recommendation ${outcome.recommendationId}.`);
      if (outcome.resolution === 'followed' && outcome.actualPoints == null) throw new Error(`Outcome ${outcome.id} says the advice was followed but records no scored points.`);
      if (data.recommendationOutcomes.some(value => value.recommendationId === outcome.recommendationId && value.observedAt === outcome.observedAt)) return;
      data.recommendationOutcomes.push(outcome);
    });
  }
  async recommendationOutcomes(recommendationId: string) {
    return (await this.read()).recommendationOutcomes
      .filter(outcome => outcome.recommendationId === recommendationId)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }
  /** Advice ages out once it and every outcome recorded against it are older than the cutoff. */
  async pruneRecommendations(before: string) {
    const cutoff = Date.parse(before);
    let removed = 0;
    await this.write(data => {
      for (const record of Object.values(data.recommendations)) {
        if (Date.parse(record.generatedAt) >= cutoff) continue;
        if (data.recommendationOutcomes.some(outcome => outcome.recommendationId === record.id && Date.parse(outcome.observedAt) >= cutoff)) continue;
        delete data.recommendations[record.id];
        data.recommendationOutcomes = data.recommendationOutcomes.filter(outcome => outcome.recommendationId !== record.id);
        removed++;
      }
    });
    return removed;
  }

  // --- Synchronization runs ---------------------------------------------------------------------
  async recordSyncRun(run: SyncRunRecord) {
    await this.write(data => {
      data.syncLog.unshift({
        id: run.id, leagueId: run.leagueId, kind: run.kind, status: run.status,
        ...(run.category ? { category: run.category } : {}),
        season: run.season ?? null, week: run.week ?? null,
        syncedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs,
        ...(run.refreshed ? { refreshed: run.refreshed } : {}),
        ...(run.nextAttemptAt ? { nextAttemptAt: run.nextAttemptAt } : {}),
        ...(run.workerId ? { workerId: run.workerId } : {}),
      });
      data.syncLog = data.syncLog.slice(0, 100);
    });
  }
  async syncRuns(query: SyncRunQuery = {}) {
    const runs = (await this.read()).syncLog
      .filter(entry => (query.leagueId === undefined || entry.leagueId === query.leagueId)
        && (query.kind === undefined || (entry.kind ?? 'league') === query.kind)
        && (query.status === undefined || entry.status === query.status))
      .map(asSyncRun);
    return query.limit === undefined ? runs : runs.slice(0, query.limit);
  }
  /**
   * Ages attempts out, keeping each league's most recent ones however old they are.
   *
   * The last thing that happened to a league that stopped synchronizing in October is exactly what
   * someone needs in March. This adapter additionally caps the whole log, because a local profile that
   * grows without limit is a file nobody can open.
   */
  async pruneSyncRuns(before: string, keepPerLeague = 100) {
    const cutoff = Date.parse(before);
    let removed = 0;
    await this.write(data => {
      const ranks = new Map<string, number>();
      const drop = new Set<StoredSyncRun>();
      for (const entry of data.syncLog) {
        const key = entry.leagueId ?? entry.kind ?? 'global';
        const rank = (ranks.get(key) ?? 0) + 1;
        ranks.set(key, rank);
        if (rank > keepPerLeague && Date.parse(entry.syncedAt) < cutoff) drop.add(entry);
      }
      data.syncLog = data.syncLog.filter(entry => !drop.has(entry));
      removed = drop.size;
    });
    return removed;
  }
  async recordSync(leagueId: string, status: SyncStatus, syncedAt: string, durationMs: number, category?: string) {
    await this.recordSyncRun({
      id: `${leagueId}:${syncedAt}`, leagueId, kind: 'league', status, durationMs,
      startedAt: syncedAt, finishedAt: new Date(Date.parse(syncedAt) + durationMs).toISOString(),
      ...(category ? { category } : {}),
    });
  }
}
