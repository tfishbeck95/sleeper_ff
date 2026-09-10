import type {
  League, LeagueSnapshot, Matchup, NflPlayer, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot,
} from '@sleeper/domain';
import type {
  ApplicationSession, ApplicationUser, ForecastSnapshotRecord, LeagueConnection,
  LeagueScoringSnapshotRecord, PlayerAlias,
  PlayerMetadataState, RecommendationOutcome, RecommendationQuery, RecommendationRecord,
  RosterHistoryQuery, RosterObservation, SessionRevocation, SleeperAccountLink, SyncAttempt,
  SyncLease, SyncRunQuery, SyncRunRecord, SyncStatus, SyncWrite, WeeklySnapshotQuery,
} from './records.js';

/**
 * The storage seam.
 *
 * Everything above this file is written against these interfaces rather than against a store. The JSON
 * adapter in `../store.ts` implements them for local development; the PostgreSQL schema in
 * `apps/api/migrations` is the same contract as tables, one per record. Selecting between them is
 * explicit configuration — see `./configure.ts`, which refuses the JSON adapter in a multi-instance
 * production deployment, where a single file cannot serialize writes across processes.
 *
 * ## The transactional contract
 *
 * **Every method here is one unit of work.** An adapter applies it atomically or not at all: a reader
 * never observes half of a method's effects, and a crash part-way through leaves the earlier state.
 * That is what makes `applySync` safe to call with an authoritative replacement in it, and what makes
 * `rotateSession` safe — a crash between retiring a session id and issuing its successor would
 * otherwise leave both usable, or neither.
 *
 * There is deliberately no `begin`/`commit` across methods. Nothing in this application needs one, and
 * offering it would force the JSON adapter to pretend to something a single file cannot provide. Where
 * several changes must land together, they are one method with one argument object — which is why
 * `SyncWrite` carries `replaceDraftPicksForLeague` rather than a caller issuing a delete and an insert.
 *
 * ## Identity and uniqueness
 *
 * Sleeper's own ids are the keys: one row per league, player, roster slot, matchup, transaction and
 * traded pick. Snapshot ids are keys too — a weekly observation's id embeds the league, season, week
 * and synchronization time, so retrying an observation is idempotent rather than duplicating it, and a
 * scoring snapshot id is unique within its league. An adapter that cannot enforce that is not
 * conformant; `./contract.ts` is the suite that checks it.
 */

export type RepositoryAdapter = 'json' | 'postgres';

export interface ApplicationUserRepository {
  applicationUser(id: string): Promise<ApplicationUser | undefined>;
  applicationUserByLogin(login: string): Promise<ApplicationUser | undefined>;
  saveApplicationUser(user: ApplicationUser): Promise<void>;
}

/**
 * Sessions.
 *
 * Only digests are stored. Revocation is by family as well as by id, because logout and theft
 * detection act on a whole rotation chain: a superseded predecessor that could still be replayed is
 * the thing rotation exists to prevent.
 */
export interface SessionRepository {
  session(idHash: string): Promise<ApplicationSession | undefined>;
  saveSession(session: ApplicationSession): Promise<void>;
  /** One unit of work: a crash must never leave both the predecessor and its successor usable. */
  rotateSession(previousIdHash: string, next: ApplicationSession, at?: string): Promise<void>;
  /** Extends the sliding idle deadline; callers throttle this so a busy client does not write per request. */
  touchSession(idHash: string, expiresAt: string, seenAt: string): Promise<void>;
  addSessionCsrfHash(idHash: string, csrfHash: string, keep?: number): Promise<void>;
  revokeSession(idHash: string, reason?: SessionRevocation, at?: string): Promise<void>;
  revokeSessionFamily(familyId: string, reason: SessionRevocation, at?: string): Promise<void>;
  revokeUserSessions(userId: string, reason?: SessionRevocation, at?: string): Promise<void>;
  /** Retention: drops sessions that can no longer authenticate anything. Returns how many went. */
  pruneSessions(now?: number, retentionMs?: number): Promise<number>;
}

/** The Sleeper account an application account claims, and the leagues it links. */
export interface SleeperAccountRepository {
  sleeperAccount(userId: string): Promise<SleeperAccountLink | undefined>;
  linkSleeperAccount(link: SleeperAccountLink): Promise<void>;
  unlinkSleeperAccount(userId: string, at?: string): Promise<void>;
  /** Which accounts still link a league. Retention deletes data only when this is empty. */
  accountsLinkingLeague(leagueId: string): Promise<string[]>;
  /** Every league any account links: the input to connection reconciliation. */
  linkedLeagueIds(): Promise<string[]>;
}

export interface LeagueConnectionRepository {
  leagueConnections(): Promise<LeagueConnection[]>;
  leagueConnection(leagueId: string): Promise<LeagueConnection | undefined>;
  activeLeagueConnections(): Promise<LeagueConnection[]>;
  connectLeague(leagueId: string, options?: { demo?: boolean; season?: string | null; week?: number | null; at?: string }): Promise<LeagueConnection>;
  updateLeagueConnection(leagueId: string, patch: Partial<LeagueConnection>, at?: string): Promise<void>;
  archiveLeagueConnection(leagueId: string, reason: string, at?: string): Promise<void>;
  /** Brings the connection set in line with the leagues the accounts actually link. */
  reconcileLeagueConnections(at?: string, demoLeagueIds?: readonly string[]): Promise<LeagueConnection[]>;
  /** Records one attempt. A failure never clears `lastSyncedAt` or removes stored data. */
  recordLeagueSyncAttempt(leagueId: string, attempt: SyncAttempt): Promise<void>;
  /**
   * Deletes one league's stored data and its connection, as one unit of work.
   *
   * Only ever called for a connection the retention policy has already archived and that no account
   * links. The shared player directory is deliberately untouched: it belongs to every league.
   */
  pruneLeague(leagueId: string): Promise<number>;
}

export interface LeagueRepository {
  league(id: string): Promise<League | undefined>;
  allLeagues(): Promise<League[]>;
  /**
   * The league's scoring observations, newest first.
   *
   * Recorded by `applySync` as part of the same unit of work that stores the league, rather than by a
   * save of its own: an observation that could be written separately could also be missed, and a
   * ranking would then cite rules nothing recorded.
   */
  scoringSnapshots(leagueId: string): Promise<LeagueScoringSnapshotRecord[]>;
  scoringSnapshot(leagueId: string, id: string): Promise<LeagueScoringSnapshotRecord | undefined>;
}

/** The shared NFL player directory and the alias map that resolves external identities onto it. */
export interface PlayerRepository {
  allPlayers(): Promise<NflPlayer[]>;
  playerDirectory(): Promise<{ players: Record<string, NflPlayer>; metadata?: PlayerMetadataState }>;
  /** Publishes the validated directory and its freshness together; a failure updates attempt state only. */
  savePlayerDirectory(metadata: PlayerMetadataState, players?: NflPlayer[]): Promise<void>;
  /** Replaces one source's aliases. Scoped to a source so one ingestion cannot disturb another's. */
  savePlayerAliases(source: string, aliases: PlayerAlias[]): Promise<number>;
  playerAliases(source?: string): Promise<PlayerAlias[]>;
  prunePlayerAliases(source: string, before: string): Promise<number>;
}

export interface RosterRepository {
  rosters(leagueId: string): Promise<Roster[]>;
  /** Append-only. Re-recording an observation of the same roster at the same instant is a no-op. */
  recordRosterObservations(observations: RosterObservation[]): Promise<number>;
  rosterHistory(leagueId: string, query?: RosterHistoryQuery): Promise<RosterObservation[]>;
  /** Retention: thins to the newest observation per roster per week once it is old enough. */
  pruneRosterHistory(before: string, keepPerWeek?: number): Promise<number>;
}

export interface WeeklySnapshotRepository {
  weeklySnapshots(leagueId: string, query?: WeeklySnapshotQuery): Promise<WeeklySnapshot[]>;
}

export interface ForecastSnapshotRepository {
  saveForecastSnapshot(record: ForecastSnapshotRecord): Promise<void>;
  forecastSnapshot(id: string): Promise<ForecastSnapshotRecord | undefined>;
  latestForecastSnapshot(season: string, week: number, source?: string): Promise<ForecastSnapshotRecord | undefined>;
  /** Retention: keeps the newest per week, and never removes one a retained recommendation cites. */
  pruneForecastSnapshots(before: string, keepPerWeek?: number): Promise<number>;
}

/**
 * Recommendations, their explanations and their outcomes.
 *
 * A recommendation is stored with the scoring snapshot and forecast that produced it. A record whose
 * scoring snapshot belongs to another league is refused rather than stored: points scored under one
 * commissioner's rules can never rank another league, in memory or at rest.
 */
export interface RecommendationRepository {
  /** One unit of work: a recommendation and its explanations are never half-written. */
  saveRecommendations(records: RecommendationRecord[]): Promise<number>;
  recommendations(query: RecommendationQuery): Promise<RecommendationRecord[]>;
  recordRecommendationOutcome(outcome: RecommendationOutcome): Promise<void>;
  recommendationOutcomes(recommendationId: string): Promise<RecommendationOutcome[]>;
  /** Retention: removes advice, its explanations and its outcomes once all of them are old enough. */
  pruneRecommendations(before: string): Promise<number>;
}

/** What synchronization did, and how fresh each resource is. */
export interface SyncRunRepository {
  recordSync(leagueId: string, status: SyncStatus, syncedAt: string, durationMs: number, category?: string): Promise<void>;
  recordSyncRun(run: SyncRunRecord): Promise<void>;
  syncRuns(query?: SyncRunQuery): Promise<SyncRunRecord[]>;
  pruneSyncRuns(before: string, keepPerLeague?: number): Promise<number>;
  resourceSyncedAt(key: string): Promise<string | undefined>;
  /** Per-resource timestamps for one league, plus the shared player directory. */
  resourceFreshness(leagueId: string): Promise<Record<string, string>>;
}

/**
 * Leases.
 *
 * `acquireLease` returns null when another owner still holds a live one — the refusal a caller has to
 * handle, never a lease that only looks taken. The PostgreSQL implementation is one statement
 * (`huddle_acquire_lease`), so two instances racing for the same key cannot both win.
 */
export interface LeaseRepository {
  acquireLease(key: string, owner: string, ttlMs: number, now?: Date): Promise<SyncLease | null>;
  releaseLease(key: string, owner: string): Promise<void>;
  lease(key: string): Promise<SyncLease | undefined>;
}

/** The rendered dashboard snapshot. Only the sample league still uses it. */
export interface DashboardSnapshotRepository {
  snapshot(id: string): Promise<LeagueSnapshot | undefined>;
  save(snapshot: LeagueSnapshot): Promise<void>;
}

export interface LeagueReadContext { league: League | undefined; rosters: Roster[]; players: NflPlayer[] }
export interface DashboardContext extends LeagueReadContext {
  users: User[]; matchups: Matchup[]; transactions: Transaction[];
  /** Undefined when transfers have never been synchronized, which is not the same as none. */
  tradedPicks: TradedDraftPick[] | undefined;
  freshness: Record<string, string>;
}
export interface LineupContext extends LeagueReadContext { users: User[]; matchups: Matchup[] }
export interface TradeContext extends LeagueReadContext { users: User[]; tradedPicks: TradedDraftPick[] | undefined }
export type WaiverContext = LeagueReadContext;

/**
 * Consistent reads.
 *
 * Each of these is one read, not several: an engine must never assemble a dashboard from separate
 * reads that can disagree about which synchronization they saw.
 */
export interface LeagueReadRepository {
  dashboardContext(leagueId: string, week: number, now?: number): Promise<DashboardContext>;
  waiverContext(leagueId: string): Promise<WaiverContext>;
  lineupContext(leagueId: string, season: string, week: number): Promise<LineupContext>;
  tradeContext(leagueId: string): Promise<TradeContext>;
}

/** Applying one synchronization's results. See `SyncWrite` for why this is a single call. */
export interface SnapshotWriteRepository {
  applySync(write: SyncWrite): Promise<void>;
}

/**
 * Everything an adapter provides.
 *
 * Modules take the narrowest port they need — authentication takes accounts and sessions, the lock
 * takes leases — so a unit test supplies a few methods rather than a store. Composition, application
 * startup and the contract suite take the whole thing.
 */
export interface HuddleRepository extends
  ApplicationUserRepository, SessionRepository, SleeperAccountRepository,
  LeagueConnectionRepository, LeagueRepository, PlayerRepository, RosterRepository,
  WeeklySnapshotRepository, ForecastSnapshotRepository, RecommendationRepository,
  SyncRunRepository, LeaseRepository, DashboardSnapshotRepository,
  LeagueReadRepository, SnapshotWriteRepository {
  /** Which adapter this is, for logs, `/health`, and the multi-instance refusal. */
  readonly adapter: RepositoryAdapter;
}
