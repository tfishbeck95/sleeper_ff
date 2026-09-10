import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { League, LeagueSnapshot, Matchup, NflPlayer, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';

export interface ApplicationUser { id: string; login: string; passwordHash: string; sleeperUserId?: string; sleeperUsername?: string; sleeperLeagueIds: string[]; createdAt: string; }
/**
 * A session record holds only digests: the raw session id and every CSRF token exist solely in the
 * client's cookie jar and memory. `expiresAt` is the sliding idle deadline and moves forward while the
 * session is used; `absoluteExpiresAt` is the hard cap that rotation carries forward and never extends.
 * Rotation issues a new id inside the same `familyId`, marking the predecessor `supersededAt` so
 * in-flight requests survive a short grace window and a later replay is recognised as token theft.
 */
export interface ApplicationSession {
  idHash: string; userId: string; familyId: string; csrfHashes: string[];
  createdAt: string; expiresAt: string; absoluteExpiresAt: string; lastRotatedAt: string; lastSeenAt: string;
  supersededAt?: string; revokedAt?: string; revokedReason?: SessionRevocation;
}
export type SessionRevocation = 'logout' | 'logout-all' | 'rotated' | 'expired' | 'reuse-detected' | 'user-removed';

export type SyncStatus = 'success' | 'failed';
/**
 * One connected league, and the week it is currently being synchronized for.
 *
 * The set of these records — not the union of every league id a Sleeper account has ever seen — is
 * what the background worker schedules. It is derived from the linked accounts on every sweep, so a
 * league that is unlinked stops being scheduled without anything else having to remember to stop it.
 *
 * The outcome fields are the record of the last attempt rather than a running log: what happened, how
 * long it took, which failure category ended it, how fresh each upstream resource is, and when the
 * next attempt is due. `nextAttemptAt` is authoritative for scheduling — it carries upstream's own
 * `Retry-After` when Sleeper sent one, and this worker's backoff when it did not.
 */
export interface LeagueConnection {
  leagueId: string;
  /** The sample league is a development affordance, and is never scheduled in production. */
  demo: boolean;
  status: 'active' | 'archived';
  /** True while at least one application account still links the league. Pruning requires false. */
  linked: boolean;
  /** The league's own season, carried from Sleeper's metadata rather than the host calendar. */
  season: string | null;
  /** The NFL week this connection is tracking. Persisted so a restart resumes where it left off. */
  week: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  archivedReason?: string;
  lastAttemptedAt?: string;
  /** The last attempt that succeeded. Retained through failures: it is what the UI still shows. */
  lastSyncedAt?: string;
  lastStatus?: SyncStatus;
  lastCategory?: string;
  lastDurationMs?: number;
  lastRefreshed?: string[];
  /** Per-resource synchronization timestamps as of the last attempt, so staleness is per resource. */
  resourceFreshness?: Record<string, string>;
  consecutiveFailures: number;
  nextAttemptAt?: string;
}
/** What one synchronization attempt produced, as recorded against its connection. */
export interface SyncAttempt {
  status: SyncStatus; at: string; durationMs: number;
  category?: string; refreshed?: string[]; season?: string | null; week?: number | null;
  resourceFreshness?: Record<string, string>; nextAttemptAt?: string; consecutiveFailures?: number;
}
/**
 * A lease held by one worker over one key.
 *
 * Leases expire rather than being released only on a clean exit, so a worker killed mid-sweep does not
 * hold the schedule shut until someone notices. See `StoreSyncLock` for what this store's
 * single-file implementation can and cannot promise across processes.
 */
export interface SyncLease { key: string; owner: string; acquiredAt: string; expiresAt: string; }

export interface StoreShape {
  snapshots: Record<string, LeagueSnapshot>;
  leagues: Record<string, League>; users: Record<string, User>; players: Record<string, NflPlayer>;
  rosters: Record<string, Roster>; matchups: Record<string, Matchup>; transactions: Record<string, Transaction>;
  draftPicks: Record<string, TradedDraftPick>; weeklySnapshots: WeeklySnapshot[];
  freshness: Record<string, string>;
  applicationUsers: Record<string, ApplicationUser>; sessions: Record<string, ApplicationSession>;
  syncLog: { leagueId: string; syncedAt: string; status: 'success' | 'failed'; category?: string; durationMs?: number }[];
  leagueConnections: Record<string, LeagueConnection>; leases: Record<string, SyncLease>;
  playerMetadata?: PlayerMetadataState;
}
export interface PlayerMetadataState {
  synchronizedAt: string | null; lastAttemptedAt: string; nextAttemptAt: string;
  lastError: string | null;
}
function revoke(session: ApplicationSession | undefined, reason: SessionRevocation, at: string) { if (!session || session.revokedAt) return; session.revokedAt = at; session.revokedReason = reason; }
const empty = (): StoreShape => ({ snapshots: {}, leagues: {}, users: {}, players: {}, rosters: {}, matchups: {}, transactions: {}, draftPicks: {}, weeklySnapshots: [], freshness: {}, applicationUsers: {}, sessions: {}, syncLog: [], leagueConnections: {}, leases: {} });
export interface SyncWrite { league?: League; users?: User[]; players?: NflPlayer[]; rosters?: Roster[]; matchups?: Matchup[]; transactions?: Transaction[]; draftPicks?: TradedDraftPick[]; replaceDraftPicksForLeague?: string; weeklySnapshot?: WeeklySnapshot; freshness?: Record<string, string>; }

export class JsonStore {
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
    if (write.league) data.leagues[write.league.id] = write.league;
    // Transfers are an authoritative snapshot: returned/native picks must not retain old owners.
    if (write.replaceDraftPicksForLeague && write.draftPicks) for (const [id, pick] of Object.entries(data.draftPicks)) if (pick.leagueId === write.replaceDraftPicksForLeague) delete data.draftPicks[id];
    upsert(data.users, write.users); upsert(data.players, write.players); upsert(data.rosters, write.rosters); upsert(data.matchups, write.matchups); upsert(data.transactions, write.transactions); upsert(data.draftPicks, write.draftPicks);
    // Weekly observations are append-only; a caller-generated id makes retrying the same observation idempotent.
    if (write.weeklySnapshot && !data.weeklySnapshots.some(snapshot => snapshot.id === write.weeklySnapshot!.id)) data.weeklySnapshots.push(write.weeklySnapshot);
    Object.assign(data.freshness, write.freshness);
  }); }
  async recordSync(leagueId: string, status: 'success' | 'failed', syncedAt: string, durationMs: number, category?: string) { await this.write(data => { data.syncLog.unshift({ leagueId, status, syncedAt, durationMs, ...(category ? { category } : {}) }); data.syncLog = data.syncLog.slice(0, 100); }); }
}
