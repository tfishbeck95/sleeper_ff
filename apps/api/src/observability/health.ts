import { isDraining } from '../lifecycle.js';
import type { RuntimeConfiguration } from '../config/environment.js';
import type { HuddleRepository } from '../storage/repositories.js';
import type { WaiverSignalProvider } from '../waiver-signals.js';
import { ProjectionFeedStore } from '../providers/feed-store.js';
import { SWEEP_LEASE_KEY } from '../scheduler/worker.js';
import {
  forecastCoverageComplete, forecastIdentityMatchRate, forecastIngestedAt, forecastPlayers,
  forecastSourceUpdatedAt, sleeperCalls, sleeperFailures, syncLastSuccess, syncOldestSuccess,
  syncStaleLeagues, syncFailingLeagues, workerHeartbeatAt,
  scoringOldestObservation, scoringStaleLeagues, scoringUnavailableLeagues,
} from './instruments.js';

/**
 * Three different questions, which used to be one endpoint.
 *
 * `/health` answered all of them at once, which meant it could only ever be right about one. The
 * distinction is not pedantry — it decides what an orchestrator *does* with the answer:
 *
 * - **Liveness** — is this process still able to answer at all? A failing liveness probe gets the
 *   process killed and replaced. So it must not consult anything: a database outage that fails a
 *   liveness probe turns one outage into a restart loop across the whole fleet, and the restarts
 *   arrive at the recovering database as a thundering herd.
 * - **Readiness** — should this instance be sent traffic right now? A failing readiness probe takes
 *   the instance out of rotation and leaves it running. This is where the database belongs, and
 *   where draining belongs: a draining instance is alive and finishing its work, and must stop
 *   receiving new requests without being killed part-way through.
 * - **Dependency status** — *why*, and what is degraded but still serving. Forecast freshness, the
 *   last successful league synchronization, the worker's heartbeat, the Sleeper error rate. None of
 *   it changes whether to route here, all of it is what an operator wants at three in the morning,
 *   and none of it is public: it is a description of the deployment's internals.
 *
 * That last line is why the first two say so little. They are reachable without a session, so the
 * answer is a status code and a word — never a version, an adapter name, a hostname, a path, an
 * upstream's name or an error message. The detail lives behind authentication and in `/metrics`.
 */

export type ReadinessState = 'ready' | 'not-ready' | 'draining';

export interface ReadinessCheck {
  /** A fixed name from a closed set. Never a message, which is where detail leaks. */
  name: 'storage' | 'configuration';
  ok: boolean;
}

export interface Readiness {
  status: ReadinessState;
  checks: ReadinessCheck[];
}

/**
 * Liveness. Answers from the process and nothing else.
 *
 * It stays 200 while draining on purpose. Draining is the process doing exactly what it was asked
 * to do, and a liveness probe that fails during a graceful shutdown is an orchestrator killing the
 * shutdown it just requested.
 */
export function liveness(): { status: 'ok' } { return { status: 'ok' }; }

/**
 * Readiness: the storage this instance cannot serve a request without, and the configuration it was
 * built from.
 *
 * The storage probe is a real read rather than a held connection or a cached flag — a pool that
 * believes it is connected is exactly the state this has to catch. It is the cheapest read in the
 * repository, and it runs on every probe, so it is also the thing that must never be expensive.
 */
export async function readiness(store: Pick<HuddleRepository, 'lease'>, configuration?: Pick<RuntimeConfiguration, 'storage'>): Promise<Readiness> {
  const checks: ReadinessCheck[] = [];
  let storageOk = false;
  try {
    // A lease read touches the same storage every write does and returns at most one small row.
    await store.lease(READINESS_PROBE_KEY);
    storageOk = true;
  } catch { storageOk = false; }
  checks.push({ name: 'storage', ok: storageOk });
  // Configuration is validated before anything is constructed, so reaching this line at all means it
  // passed. It is reported anyway: "which of the two failed" is the first question asked, and an
  // answer that only ever has one possible value is still the answer.
  checks.push({ name: 'configuration', ok: Boolean(configuration) || true });

  if (isDraining()) return { status: 'draining', checks };
  return { status: checks.every(check => check.ok) ? 'ready' : 'not-ready', checks };
}

/** A key nothing writes, so the probe reads storage without contending with anything that does. */
export const READINESS_PROBE_KEY = 'readiness:probe';

// --- Dependency status ---------------------------------------------------------------------------

export type DependencyState = 'ready' | 'degraded' | 'stale' | 'unavailable';

export interface ForecastStatus {
  state: DependencyState;
  ingestedAt: string | null;
  ageSeconds: number | null;
  /** The source's own timestamp on the feed, which is the only thing that catches a source that stopped publishing while still answering 200. */
  sourceUpdatedAt: string | null;
  players: number | null;
  identityMatchRate: number | null;
  coverageComplete: boolean | null;
  /** A fixed reason from a closed set, so it can be alerted on rather than only read. */
  reason: string | null;
}

export interface LeagueSyncStatus {
  state: DependencyState;
  activeLeagues: number;
  lastSuccessAt: string | null;
  oldestSuccessAt: string | null;
  staleLeagues: number;
  failingLeagues: number;
  /** The deepest consecutive-failure streak across active leagues. */
  worstFailureStreak: number;
}

export interface WorkerStatus {
  state: DependencyState;
  /** When the schedule's lease was last held. The worker renews it while it sweeps. */
  heartbeatAt: string | null;
  ageSeconds: number | null;
  /** Whether a lease is currently held at all, which is what "a worker is running" means here. */
  held: boolean;
}

export interface SleeperStatus {
  state: DependencyState;
  calls: number;
  failures: number;
  /** Failures over calls since this process started. A rate, not a count, so it is comparable. */
  errorRate: number;
}

export interface ScoringStatus {
  state: DependencyState;
  leagues: number;
  /** Leagues whose live scoring did not validate. Their rankings are refused outright. */
  unavailable: number;
  /** Leagues whose scoring observation is older than the threshold but did validate. */
  stale: number;
  oldestObservedAt: string | null;
}

export interface DependencyStatus {
  scoring: ScoringStatus;
  forecast: ForecastStatus;
  leagueSync: LeagueSyncStatus;
  worker: WorkerStatus;
  sleeper: SleeperStatus;
  /** The worst state across all of the above, so one field answers "is anything wrong". */
  state: DependencyState;
}

export interface DependencyThresholds {
  /** Past this, a validated scoring observation is old enough that the rules may have moved. */
  scoringStaleMs: number;
  /** Past this, the retained forecast stops being usable for ranking. */
  forecastStaleMs: number;
  /** Past this without a successful synchronization, a league is stale. */
  leagueStaleMs: number;
  /** Past this without the schedule's lease being renewed, the worker is presumed gone. */
  workerHeartbeatMs: number;
  /** Consecutive failures on one league before it is a problem rather than a bad afternoon. */
  failureStreak: number;
  minIdentityMatchRate: number;
}

export const DEFAULT_THRESHOLDS: DependencyThresholds = {
  // A commissioner can change scoring mid-week, and every ranking derived from the old observation
  // is then priced against rules that no longer apply.
  scoringStaleMs: 6 * 3_600_000,
  forecastStaleMs: 12 * 3_600_000,
  leagueStaleMs: 3 * 3_600_000,
  // Two sweeps at the default interval: one missed sweep is a restart, two is a worker that is gone.
  workerHeartbeatMs: 65 * 60_000,
  failureStreak: 3,
  minIdentityMatchRate: 0.95,
};

const ageMs = (at: string | null | undefined, now: number) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? now - parsed : null;
};
const worst = (states: DependencyState[]): DependencyState => {
  const order: DependencyState[] = ['unavailable', 'stale', 'degraded', 'ready'];
  return order.find(state => states.includes(state)) ?? 'ready';
};

async function forecastStatus(provider: WaiverSignalProvider | null, thresholds: DependencyThresholds, now: number): Promise<ForecastStatus> {
  const absent: ForecastStatus = { state: 'unavailable', ingestedAt: null, ageSeconds: null, sourceUpdatedAt: null, players: null, identityMatchRate: null, coverageComplete: null, reason: 'no_feed' };
  // Only the retained feed can answer this. A file-based `WAIVER_SIGNALS_PATH` fixture has no
  // ingestion record, so it reports as configured-but-unmeasured rather than as a stale feed.
  if (!(provider instanceof ProjectionFeedStore)) return provider ? { ...absent, state: 'degraded', reason: 'unmeasured_source' } : absent;
  const state = await provider.state();
  if (!state) return absent;
  const age = ageMs(state.provenance.ingestedAt, now) ?? 0;
  const identityMatchRate = state.report.identity.total > 0 ? state.report.identity.rate : null;
  const coverageComplete = state.report.coverage ? state.report.coverage.complete : null;
  const reason = state.stale ? 'stale'
    : identityMatchRate !== null && identityMatchRate < thresholds.minIdentityMatchRate ? 'identity_match_below_threshold'
      : coverageComplete === false ? 'incomplete_coverage' : null;
  return {
    state: state.stale ? 'stale' : reason ? 'degraded' : 'ready',
    ingestedAt: state.provenance.ingestedAt ?? null,
    ageSeconds: Math.round(age / 1000),
    sourceUpdatedAt: state.provenance.sourceTimestamp ?? null,
    players: state.players,
    identityMatchRate,
    coverageComplete,
    reason,
  };
}

async function leagueSyncStatus(store: Pick<HuddleRepository, 'activeLeagueConnections'>, thresholds: DependencyThresholds, now: number): Promise<LeagueSyncStatus> {
  const connections = (await store.activeLeagueConnections()).filter(connection => !connection.demo);
  if (!connections.length) {
    return { state: 'ready', activeLeagues: 0, lastSuccessAt: null, oldestSuccessAt: null, staleLeagues: 0, failingLeagues: 0, worstFailureStreak: 0 };
  }
  let newest = 0, oldest = Number.POSITIVE_INFINITY, stale = 0, failing = 0, worstStreak = 0;
  for (const connection of connections) {
    const at = connection.lastSyncedAt ? Date.parse(connection.lastSyncedAt) : Number.NaN;
    if (Number.isFinite(at)) { newest = Math.max(newest, at); oldest = Math.min(oldest, at); }
    // A league that has never synchronized is as stale as one that stopped: both are serving nothing.
    if (!Number.isFinite(at) || now - at > thresholds.leagueStaleMs) { stale += 1; oldest = 0; }
    if (connection.lastStatus === 'failed') failing += 1;
    worstStreak = Math.max(worstStreak, connection.consecutiveFailures ?? 0);
  }
  const state: DependencyState = stale === connections.length ? 'unavailable'
    : stale > 0 ? 'stale'
      : worstStreak >= thresholds.failureStreak ? 'degraded' : 'ready';
  return {
    state, activeLeagues: connections.length,
    lastSuccessAt: newest ? new Date(newest).toISOString() : null,
    oldestSuccessAt: Number.isFinite(oldest) && oldest > 0 ? new Date(oldest).toISOString() : null,
    staleLeagues: stale, failingLeagues: failing, worstFailureStreak: worstStreak,
  };
}

async function workerStatus(store: Pick<HuddleRepository, 'lease'>, thresholds: DependencyThresholds, now: number): Promise<WorkerStatus> {
  const lease = await store.lease(SWEEP_LEASE_KEY);
  if (!lease) return { state: 'unavailable', heartbeatAt: null, ageSeconds: null, held: false };
  // The lease is renewed while a sweep works through its queue, so its acquisition time is the
  // closest thing to a heartbeat that survives a process being killed: an expired one is a worker
  // that stopped without releasing it.
  const age = ageMs(lease.acquiredAt, now) ?? Number.POSITIVE_INFINITY;
  const expired = Date.parse(lease.expiresAt) < now;
  return {
    state: age > thresholds.workerHeartbeatMs ? 'unavailable' : expired ? 'degraded' : 'ready',
    heartbeatAt: lease.acquiredAt, ageSeconds: Math.round(age / 1000), held: !expired,
  };
}

/**
 * The Sleeper error rate, read from this process's own counters.
 *
 * Since process start rather than over a window: a windowed rate needs a time series, and there is
 * one — `/metrics` — whose whole job is computing rates properly. This is the number that answers
 * "is Sleeper unwell right now" without a monitoring stack attached, and it is honest about being
 * cumulative.
 */
function sleeperStatus(): SleeperStatus {
  let calls = 0, failures = 0;
  for (const outcome of ['success', 'failure']) {
    for (const endpoint of SLEEPER_ENDPOINTS) calls += sleeperCalls.value({ endpoint, outcome });
  }
  for (const endpoint of SLEEPER_ENDPOINTS) {
    for (const category of SLEEPER_CATEGORIES) failures += sleeperFailures.value({ endpoint, category });
  }
  const errorRate = calls ? failures / calls : 0;
  return { state: !calls ? 'ready' : errorRate >= 0.5 ? 'unavailable' : errorRate >= 0.1 ? 'degraded' : 'ready', calls, failures, errorRate: Number(errorRate.toFixed(4)) };
}

/** The closed sets the Sleeper counters are labelled with, so a read can enumerate them. */
export const SLEEPER_ENDPOINTS = ['user', 'leagues', 'league', 'rosters', 'leagueUsers', 'matchups', 'transactions', 'drafts', 'tradedPicks', 'players'] as const;
export const SLEEPER_CATEGORIES = ['timeout', 'network', 'rate_limit', 'not_found', 'server', 'client', 'validation'] as const;

/**
 * The scoring observations behind the active leagues.
 *
 * Read from one call rather than one per league: a per-league read would be correct and would also
 * be N reads on every alert evaluation, which is the kind of cost that gets monitoring turned off.
 */
async function scoringStatus(store: Pick<HuddleRepository, 'allLeagues' | 'activeLeagueConnections'>, thresholds: DependencyThresholds, now: number): Promise<ScoringStatus> {
  const active = new Set((await store.activeLeagueConnections()).filter(connection => !connection.demo).map(connection => connection.leagueId));
  const leagues = (await store.allLeagues()).filter(league => active.has(league.id));
  if (!leagues.length) return { state: 'ready', leagues: 0, unavailable: 0, stale: 0, oldestObservedAt: null };
  let unavailable = 0, stale = 0, oldest = Number.POSITIVE_INFINITY;
  for (const league of leagues) {
    const scoring = league.scoring;
    if (!scoring || scoring.kind === 'unavailable') { unavailable += 1; continue; }
    const observed = scoring.synchronizedAt ? Date.parse(scoring.synchronizedAt) : Number.NaN;
    if (!Number.isFinite(observed) || now - observed > thresholds.scoringStaleMs) stale += 1;
    if (Number.isFinite(observed)) oldest = Math.min(oldest, observed);
  }
  return {
    state: unavailable === leagues.length ? 'unavailable' : unavailable > 0 ? 'degraded' : stale > 0 ? 'stale' : 'ready',
    leagues: leagues.length, unavailable, stale,
    oldestObservedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
  };
}

export interface DependencySources {
  store: Pick<HuddleRepository, 'activeLeagueConnections' | 'lease' | 'allLeagues'>;
  forecast: WaiverSignalProvider | null;
  thresholds?: DependencyThresholds;
  now?: () => number;
}

/**
 * The whole internal picture, gathered once.
 *
 * It also publishes what it found to the gauges, so the same read serves the authenticated status
 * endpoint and the metrics scrape. Gathering twice would mean the two could disagree, and an
 * operator comparing a dashboard against a status page is exactly who would notice.
 */
export async function dependencyStatus({ store, forecast, thresholds = DEFAULT_THRESHOLDS, now = Date.now }: DependencySources): Promise<DependencyStatus> {
  const at = now();
  const [scoring, forecastState, syncState, worker] = await Promise.all([
    scoringStatus(store, thresholds, at),
    forecastStatus(forecast, thresholds, at),
    leagueSyncStatus(store, thresholds, at),
    workerStatus(store, thresholds, at),
  ]);
  const sleeper = sleeperStatus();

  forecastIngestedAt.set({}, forecastState.ingestedAt ? Date.parse(forecastState.ingestedAt) / 1000 : 0);
  forecastSourceUpdatedAt.set({}, forecastState.sourceUpdatedAt ? Date.parse(forecastState.sourceUpdatedAt) / 1000 : 0);
  if (forecastState.players !== null) forecastPlayers.set({}, forecastState.players);
  if (forecastState.identityMatchRate !== null) forecastIdentityMatchRate.set({}, forecastState.identityMatchRate);
  if (forecastState.coverageComplete !== null) forecastCoverageComplete.set({}, forecastState.coverageComplete ? 1 : 0);
  syncLastSuccess.set({}, syncState.lastSuccessAt ? Date.parse(syncState.lastSuccessAt) / 1000 : 0);
  syncOldestSuccess.set({}, syncState.oldestSuccessAt ? Date.parse(syncState.oldestSuccessAt) / 1000 : 0);
  syncStaleLeagues.set({}, syncState.staleLeagues);
  syncFailingLeagues.set({ depth: 'any' }, syncState.failingLeagues);
  syncFailingLeagues.set({ depth: 'streak' }, syncState.worstFailureStreak);
  workerHeartbeatAt.set({}, worker.heartbeatAt ? Date.parse(worker.heartbeatAt) / 1000 : 0);
  scoringUnavailableLeagues.set({}, scoring.unavailable);
  scoringStaleLeagues.set({}, scoring.stale);
  scoringOldestObservation.set({}, scoring.oldestObservedAt ? Date.parse(scoring.oldestObservedAt) / 1000 : 0);

  return {
    scoring, forecast: forecastState, leagueSync: syncState, worker, sleeper,
    state: worst([scoring.state, forecastState.state, syncState.state, worker.state, sleeper.state]),
  };
}
