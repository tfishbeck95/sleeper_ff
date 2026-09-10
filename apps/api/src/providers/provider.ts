import type { IndividualSpecialTeamsForecast, KickerDistanceBand, PointsAllowedBucket, YardsAllowedBucket } from '@sleeper/domain';
import type { WeeklyOpportunity } from '../waiver-signals.js';

/**
 * The provider-adapter boundary.
 *
 * Everything here is *pre-validation, pre-identity* material: what a licensed source actually
 * publishes, in the source's own units and under the source's own player ids. Nothing in this file
 * is a feed. `ingest.ts` resolves identities, derives the fields Sleeper's contracts require and no
 * source publishes, and only then hands a candidate feed to `parseWaiverSignals` for validation.
 *
 * The separation matters for two reasons. A source's raw records are frequently licensed for use but
 * not for redistribution, so they must never reach a response body; and a source's *mean* is not the
 * *distribution* the defense contract requires, so the step that turns one into the other has to be
 * a named, testable, disclosed transformation rather than an implicit cast.
 */

/**
 * The licence under which one source's data enters this application, recorded so a reviewer can
 * check the claim rather than trust it. `redistributable` gates whether ingested raw records may
 * ever be served; a source that forbids redistribution can still lawfully drive league-scored output.
 */
export interface SourceLicense {
  /** Recorded verbatim as the feed's `source`, so every scored point can name where it came from. */
  name: string;
  license: string;
  licenseUrl: string;
  /** Required attribution text, or null when the licence imposes none. Surfaced with derived output. */
  attribution: string | null;
  /** False when the terms permit use but forbid serving the source's own records onward. */
  redistributable: boolean;
  /** Environment variable holding the credential, named so operations can rotate it. Null when public. */
  credentialEnvVar: string | null;
}

/** A source's own player record, before it is known to correspond to any Sleeper player. */
export interface ProviderIdentity {
  providerId: string;
  name: string;
  team: string | null;
  position: string | null;
  /** Cross-reference ids the source publishes, keyed by namespace: `gsis`, `sportradar`, `espn`, `pfr`, `yahoo`. */
  crossIds: Readonly<Record<string, string>>;
}

/** One row of a licensed identity map: the bridge from a source's namespaces to a Sleeper player id. */
export interface IdentityLink {
  sleeperId: string;
  name: string;
  team: string | null;
  position: string | null;
  crossIds: Readonly<Record<string, string>>;
}

/**
 * A kicker line as sources actually publish it.
 *
 * Sleeper scores `fgm_50_59` and `fgm_60p` separately; no projection source splits them, publishing a
 * single 50-plus figure instead. That combined band is carried here explicitly rather than being
 * silently assigned to one Sleeper key, and `derivation.ts` splits it against an empirical
 * distribution before the kicker contract ever sees it.
 */
export type ProviderDistanceBand = Exclude<KickerDistanceBand, '50_59' | '60p'> | '50p';
export interface ProviderKickerLine {
  fieldGoals: Record<ProviderDistanceBand, { attempts: number; makes: number }>;
  pat: { makes: number; misses: number };
  /** Total attempts that did not score, blocks included. Sources report this as a total, never by band. */
  misses: number;
  /** Supplied when the source models it; otherwise derived from the 50-plus attempt count. */
  longAttemptProbability?: number;
}

/**
 * A team-defense line as sources actually publish it: event counts plus *mean* points and yards
 * allowed. The mean is not a distribution, and Sleeper's tier bonuses are priced on probabilities, so
 * the two mean fields here are inputs to a derivation, never a shortcut around one.
 */
export interface ProviderDefenseLine {
  sacks: number; interceptions: number; forcedFumbles: number; fumbleRecoveries: number;
  safeties: number; blockedKicks: number; defensiveTouchdowns: number;
  pointsAllowed: number; yardsAllowed: number;
  /** The unit's own return events, where the source models them at all. */
  specialTeams?: { touchdowns: number; forcedFumbles: number; fumbleRecoveries: number };
  /** Complete tier probabilities, on the day a source begins publishing them. Skips derivation. */
  pointsAllowedDistribution?: Record<PointsAllowedBucket, number>;
  yardsAllowedDistribution?: Record<YardsAllowedBucket, number>;
}

/** One scored scenario. `stats` is the mean; floor and ceiling are the same units, never a point range. */
export interface ProviderWeekProjection {
  week: number;
  stats: Record<string, number>;
  floorStats?: Record<string, number>;
  ceilingStats?: Record<string, number>;
  kicker?: ProviderKickerLine; floorKicker?: ProviderKickerLine; ceilingKicker?: ProviderKickerLine;
  defense?: ProviderDefenseLine; floorDefense?: ProviderDefenseLine; ceilingDefense?: ProviderDefenseLine;
  specialTeams?: IndividualSpecialTeamsForecast;
  opponent?: string | null;
  bye?: boolean;
  opportunity?: WeeklyOpportunity;
}

/**
 * An availability window rather than a status string.
 *
 * A designation alone ("Questionable") says nothing about which weeks a manager can plan around.
 * `unavailableThroughWeek` is the last week the source expects the player out; null means the source
 * expects availability, which is distinct from the source having no opinion — that is `status: null`.
 */
export interface ProviderInjury {
  status: string | null;
  designation: string | null;
  practiceStatus: string | null;
  unavailableThroughWeek: number | null;
  /** When the source last revised this report; distinct from when we ingested it. */
  reportedAt: string;
}

/** Everything one source knows about one player for one ingestion, in the source's own namespace. */
export interface ProviderPlayerProjection {
  identity: ProviderIdentity;
  weeks: ProviderWeekProjection[];
  /** Remaining-season forecast: an expected stat line for a future typical week. */
  restOfSeason?: {
    stats: Record<string, number>;
    kicker?: ProviderKickerLine;
    defense?: ProviderDefenseLine;
    specialTeams?: IndividualSpecialTeamsForecast;
    /** Weeks the forecast spans, so a partial remaining season is not read as a full one. */
    weeksRemaining: number;
  };
  injury: ProviderInjury | null;
  /** Opportunity/role share movement. Fractions from 0 to 1, as the waiver contract requires. */
  role?: { recentShare: number; previousShare: number; games: number };
  /** Observed targets in recent games, oldest first. Never smoothed projections. */
  recentTargets?: number[];
  age?: number;
}

/**
 * What a source can and cannot express, declared rather than discovered.
 *
 * Requirements this application places on a feed — floor and ceiling scenarios, Sleeper's two long
 * field-goal bands, tier probabilities — are met by no source in full. Declaring the shortfall up
 * front turns "the feed has no ceiling for anyone" from an anomaly a reader has to diagnose into a
 * property of the source that the ingestion report states in one line.
 */
export interface ProviderCapabilities {
  /** `mean-only` sources supply no scenarios; nothing invents them, and the gap is reported. */
  scenarios: 'mean-only' | 'floor-ceiling';
  restOfSeason: boolean;
  opportunity: boolean;
  /** `combined-50-plus` requires the long-band derivation before the kicker contract will accept it. */
  kickerDistanceBands: 'none' | 'combined-50-plus' | 'sleeper-bands';
  /** False when the source publishes only mean points/yards allowed, requiring the tier derivation. */
  defenseTierDistributions: boolean;
  individualSpecialTeams: boolean;
}

/** What one fetch returned, and when the source itself says it was current. */
export interface ProviderFetch {
  sourceTimestamp: string;
  players: ProviderPlayerProjection[];
  /** Transformations the driver had to apply to reach the canonical shape, disclosed to the report. */
  notes?: Array<{ field: string; method: string; basis: string; explanation: string }>;
}

/** A source of forward projections. Fetches one week; never scores, never maps identity. */
export interface ProjectionProvider {
  readonly source: SourceLicense;
  readonly capabilities: ProviderCapabilities;
  fetchWeek(season: string, week: number, signal?: AbortSignal): Promise<ProviderFetch>;
}

/**
 * A source of the facts projections are useless without: which Sleeper player a provider row is,
 * when a team is idle, and what the official injury report says. Deliberately separate, because the
 * licence that permits forward projections is rarely the licence that permits an identity map.
 */
export interface ReferenceDataProvider {
  readonly source: SourceLicense;
  identityMap(season: string, signal?: AbortSignal): Promise<{ sourceTimestamp: string; links: IdentityLink[] }>;
  byeWeeks(season: string, signal?: AbortSignal): Promise<{ sourceTimestamp: string; byes: Readonly<Record<string, number>> }>;
  injuries(season: string, week: number, signal?: AbortSignal): Promise<{ sourceTimestamp: string; reports: Array<{ crossIds: Readonly<Record<string, string>>; name: string; team: string | null; injury: ProviderInjury }> }>;
}

/**
 * Provenance carried by every ingested feed.
 *
 * `sourceTimestamp` is when the source says its data was current; `ingestedAt` is when we observed
 * it. Conflating them is how a stale feed passes for a fresh one: a source that stops updating keeps
 * returning 200 with an old `sourceTimestamp`, and only the gap between the two reveals it.
 */
export interface FeedProvenance {
  season: string;
  week: number;
  sourceName: string;
  sourceTimestamp: string;
  ingestedAt: string;
  /** Every licence that contributed, so attribution and redistribution limits travel with the feed. */
  licenses: SourceLicense[];
  /** Contributing sources and their own timestamps, for a feed assembled from more than one. */
  contributions: Array<{ source: string; sourceTimestamp: string; role: 'projections' | 'reference' }>;
}

/** Why one source row never became a feed entry. Reported, never silently dropped. */
export type UnresolvedReason = 'no-match' | 'ambiguous' | 'not-in-sleeper' | 'position-mismatch' | 'inactive';
export interface UnresolvedIdentity {
  providerId: string;
  name: string;
  team: string | null;
  position: string | null;
  reason: UnresolvedReason;
  /** Sleeper ids considered and rejected, so an ambiguous match can be adjudicated by hand. */
  candidates: string[];
  message: string;
}
