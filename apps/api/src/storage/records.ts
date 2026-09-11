import type { League, Matchup, NflPlayer, Roster, ScoringConfiguration, ScoringIssue, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';

/**
 * The records the repository interfaces move.
 *
 * They live beside the interfaces rather than inside the JSON adapter, because they are the contract
 * every adapter implements: the PostgreSQL schema in `apps/api/migrations` stores exactly these
 * fields, one table per record. `store.ts` re-exports them so existing imports keep working.
 */

export interface ApplicationUser {
  id: string; login: string; passwordHash: string;
  sleeperUserId?: string; sleeperUsername?: string; sleeperLeagueIds: string[];
  /** When the Sleeper account was claimed. Absent on accounts that predate the association record. */
  sleeperLinkedAt?: string;
  createdAt: string;
}

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

/**
 * The Sleeper account an application account claims, and the leagues it links.
 *
 * The association is its own record because it is its own decision: an account exists before it claims
 * a Sleeper identity, the claim can be replaced, and the linked leagues are what league connection
 * reconciliation derives the schedule from.
 */
export interface SleeperAccountLink {
  userId: string; sleeperUserId: string; sleeperUsername: string;
  leagueIds: string[]; linkedAt: string;
}

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
 * One attempt, as the log behind the connection record keeps it.
 *
 * The connection carries the last attempt because that is what the dashboard reports; these are what
 * an operator reads when a league has been failing all day. The player directory and the forecast feed
 * produce runs of their own, which is why `leagueId` is nullable and `kind` says what ran.
 */
export interface SyncRunRecord {
  id: string; leagueId: string | null; kind: 'league' | 'players' | 'forecast';
  status: SyncStatus; category?: string;
  season?: string | null; week?: number | null;
  startedAt: string; finishedAt: string; durationMs: number;
  refreshed?: string[]; nextAttemptAt?: string; workerId?: string;
}
export interface SyncRunQuery { leagueId?: string; kind?: SyncRunRecord['kind']; status?: SyncStatus; limit?: number }

/**
 * A lease held by one worker over one key.
 *
 * Leases expire rather than being released only on a clean exit, so a worker killed mid-sweep does not
 * hold the schedule shut until someone notices. See `StoreSyncLock` for what the JSON adapter's
 * single-file implementation can and cannot promise across processes.
 */
export interface SyncLease { key: string; owner: string; acquiredAt: string; expiresAt: string; }

export interface PlayerMetadataState {
  synchronizedAt: string | null; lastAttemptedAt: string; nextAttemptAt: string;
  lastError: string | null;
}

/**
 * One validated observation of a league's scoring rules.
 *
 * Every scored projection carries the id, so a ranking can prove which observation produced its points
 * and a commissioner's change invalidates earlier scoring rather than silently repricing it. Kept as
 * history: a recommendation made three weeks ago cites the rules that were in force then, and an
 * adapter that only kept the current observation could not honour that citation.
 */
export interface LeagueScoringSnapshotRecord {
  id: string; leagueId: string; kind: ScoringConfiguration['kind'];
  /** Null only for a reference observation that was never synchronized. */
  observedAt: string | null;
  lastAttemptedAt?: string;
  settings: Readonly<Record<string, number>> | null;
  /** The exact upstream representation, including unrecognized keys and invalid values. */
  rawSettings: unknown;
  issues: ScoringIssue[];
  recordedAt: string;
}

/**
 * An external identity resolved onto a Sleeper player id.
 *
 * A mismapped identity is worse than a missing one: it attributes one player's projection to another
 * and every number downstream stays plausible. `(source, aliasKey)` is therefore the key — one source's
 * identifier resolves to exactly one player, or to nothing at all. Ambiguity is reported unresolved by
 * the ingestion rather than stored as a guess.
 */
export interface PlayerAlias {
  source: string; aliasKey: string; playerId: string;
  kind: 'cross-id' | 'team-defense' | 'name-team-position' | 'name-position';
  displayName?: string | null; team?: string | null; position?: string | null;
  observedAt: string;
}

/**
 * What a roster held when it was observed.
 *
 * Rosters themselves are mutable mirrors of the current upstream state. History is what makes a
 * recommendation reviewable afterwards: it is the only way to answer whether the player a
 * recommendation named was actually on the roster in the week it was made. Append-only, keyed by the
 * observation so re-recording one is idempotent.
 */
export interface RosterObservation {
  id: string; leagueId: string; rosterId: number; season: string; week: number; observedAt: string;
  ownerId: string | null; coOwnerIds: string[];
  playerIds: string[]; starterIds: string[]; reserveIds: string[]; taxiIds: string[];
  settings: Record<string, number>;
  weeklySnapshotId?: string;
}
export interface RosterHistoryQuery { season?: string; week?: number; rosterId?: number; limit?: number }
export interface WeeklySnapshotQuery { season?: string; week?: number; limit?: number }

/**
 * One ingested, validated forecast: raw projected statistics for one source, season and week.
 *
 * `sourceUpdatedAt` is when the source says its data was current; `ingestedAt` is when we observed it.
 * Conflating them is how a stale feed passes for a fresh one, so both are recorded and the freshness
 * thresholds are applied to each separately. Rows never carry fantasy points — the scoring boundary
 * produces those from these statistics under the league's own rules.
 */
export interface ForecastSnapshotRecord {
  id: string; source: string; season: string; week: number;
  sourceUpdatedAt: string; ingestedAt: string;
  playerCount: number;
  /** Measured share of source rows that resolved to a Sleeper id. */
  identityMatchRate?: number | null;
  /** Fields Sleeper's contracts require that no source publishes, derived rather than passed off. */
  derivedFields?: string[];
  /** Category coverage measured against the live league's own rules. */
  coverage?: Record<string, unknown>;
  licenses?: unknown[];
  report?: unknown;
}

/**
 * One recommendation, with the provenance that makes it reviewable.
 *
 * `scoringSnapshotId` is not decoration: points scored under one commissioner's rules may never rank
 * another league, and the stored citation is what lets a later review prove which rules and which
 * forecast produced this advice.
 */
export interface RecommendationRecord {
  id: string; leagueId: string; season: string; week: number; rosterId: number;
  kind: 'start' | 'sit' | 'waiver' | 'trade' | 'streamer';
  subjectPlayerId?: string | null; counterpartPlayerId?: string | null;
  title: string; rationale: string;
  confidence?: number | null;
  /** League-scored points from the scoring boundary. Never a provider's own points. */
  projectedPoints?: number | null;
  scoringSnapshotId: string;
  forecastSnapshotId?: string | null;
  generatedAt: string;
  payload?: Record<string, unknown>;
  explanations?: RecommendationExplanation[];
}

/**
 * The itemized reasoning behind one recommendation, in the order it is shown.
 *
 * Scoring contributions and post-scoring adjustments are separate kinds because they are separate
 * things. A `coverage` note carries no weight at all — a category a provider does not model may never
 * promote the player it concerns, and may never demote one either.
 */
export interface RecommendationExplanation {
  ordinal: number;
  kind: 'scoring' | 'contribution' | 'adjustment' | 'risk' | 'coverage' | 'alternative';
  label: string; detail: string; points?: number | null;
}

/**
 * What actually happened.
 *
 * One recommendation can be observed more than once: Sleeper corrects statistics after the fact, and a
 * corrected week is a new observation rather than an edit of the old one. `resolution` records whether
 * the manager took the advice at all, because a recommendation nobody followed says nothing about
 * whether it was right.
 */
export interface RecommendationOutcome {
  id: string; recommendationId: string; observedAt: string;
  resolution: 'followed' | 'not-followed' | 'unknown' | 'expired';
  projectedPoints?: number | null; actualPoints?: number | null; counterfactualPoints?: number | null;
  /** The rules the actual points were scored under, which need not be the ones that projected them. */
  scoringSnapshotId?: string | null;
  note?: string; recordedAt: string;
}
export interface RecommendationQuery {
  leagueId: string; season?: string; week?: number; rosterId?: number;
  kind?: RecommendationRecord['kind']; playerId?: string; limit?: number;
}

/**
 * One authoritative league snapshot, applied as a single unit of work.
 *
 * `replaceDraftPicksForLeague` is the reason this is a write object rather than a set of calls: traded
 * picks are an authoritative set, not an accumulating log, and a pick that returns to its original
 * owner disappears from Sleeper's response entirely. The delete and the insert have to land together
 * or a reader sees a league with no picks at all.
 */
export interface SyncWrite {
  /** A publisher whose lease expired or was replaced must not overwrite a successor's snapshot. */
  leaseGuard?: { key: string; owner: string; now: string };
  league?: League; users?: User[]; players?: NflPlayer[]; rosters?: Roster[];
  matchups?: Matchup[]; transactions?: Transaction[]; draftPicks?: TradedDraftPick[];
  replaceDraftPicksForLeague?: string;
  weeklySnapshot?: WeeklySnapshot;
  freshness?: Record<string, string>;
  /** Append-only roster observations taken alongside the snapshot. */
  rosterObservations?: RosterObservation[];
}
