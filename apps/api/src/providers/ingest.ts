import type { NflPlayer, ScoringRules } from '@sleeper/domain';
import { parseWaiverSignals, type PlayerSignal, type WeeklyForecast, type WaiverSignals } from '../waiver-signals.js';
import { assessCoverage, DEFENSE_IMPLIED_KEYS, KICKER_IMPLIED_KEYS, individualSpecialTeamsKeys, teamSpecialTeamsKeys, type CoverageReport, type Family } from './coverage.js';
import { deriveDefenseForecast, deriveKickerForecast, NFLVERSE_BASIS, type DerivationNote, type EmpiricalBasis } from './derivation.js';
import type { ProjectionFeedStore } from './feed-store.js';
import { normalizeTeam, resolveIdentities, type IdentityResolution } from './identity.js';
import type { FeedProvenance, ProjectionProvider, ProviderInjury, ProviderPlayerProjection, ProviderWeekProjection, ReferenceDataProvider, UnresolvedIdentity } from './provider.js';
import {
  ConsoleAlerter, DEFAULT_SERVICE_LEVEL, evaluateServiceLevel, highestSeverity,
  type Alerter, type IngestionReport, type ServiceLevel,
} from './service-level.js';

/**
 * The ingestion pipeline: fetch, resolve, derive, validate, publish.
 *
 * The ordering is the point. Nothing is written until a candidate feed has passed the same
 * `parseWaiverSignals` validation the file adapter applies, so a bad upstream day cannot replace a
 * good feed with a worse one — a rejected run leaves the last good feed exactly where it was and
 * says so. Nothing is scored here either: this produces raw statistics, and the league's own rules
 * turn them into points at the single boundary in `projection-scoring.ts`.
 */

export interface IngestionDependencies {
  projections: ProjectionProvider;
  reference: ReferenceDataProvider;
  store: ProjectionFeedStore;
  /** The synchronized Sleeper player directory; identity resolution is checked against it. */
  sleeperPlayers: () => Promise<readonly NflPlayer[]>;
  /**
   * The live league's validated scoring rules, used only to decide which categories the feed *owes*.
   * Null when no league has a complete-live snapshot yet, in which case coverage is not assessable
   * and is reported as such rather than assumed complete.
   */
  scoring?: () => Promise<ScoringRules | null>;
  level?: ServiceLevel;
  alerter?: Alerter;
  basis?: EmpiricalBasis;
  now?: () => Date;
  /** Unresolved identities are stored in full up to this many rows; the count is always exact. */
  maxUnresolvedRecorded?: number;
}

/** Explicit zeroes for a week a player's team does not play. On a bye, zero is a fact, not a guess. */
const BYE_LINES: Readonly<Record<Family, Record<string, number>>> = Object.freeze({
  QB: { pass_yd: 0, pass_td: 0, pass_int: 0, rush_yd: 0, rush_td: 0 },
  RB: { rush_yd: 0, rush_td: 0, rec: 0, rec_yd: 0, rec_td: 0 },
  WR: { rec: 0, rec_yd: 0, rec_td: 0, rush_yd: 0, rush_td: 0 },
  TE: { rec: 0, rec_yd: 0, rec_td: 0 },
  K: { xpm: 0, fgm_0_19: 0, fgm_20_29: 0, fgm_30_39: 0, fgm_40_49: 0, fgm_50_59: 0, fgm_60p: 0 },
  DEF: { sack: 0, int: 0, ff: 0, fum_rec: 0, safe: 0, blk_kick: 0, def_td: 0 },
});
const FAMILY_OF: Readonly<Record<string, Family>> = Object.freeze({ QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K', DEF: 'DEF', DST: 'DEF' });
const familyOf = (player: NflPlayer): Family | null => {
  for (const position of [player.position, ...player.fantasyPositions]) {
    const family = position ? FAMILY_OF[position.toUpperCase()] : undefined;
    if (family) return family;
  }
  return null;
};

export class ProjectionIngestionService {
  private readonly level: ServiceLevel;
  private readonly alerter: Alerter;
  private readonly basis: EmpiricalBasis;
  private readonly now: () => Date;
  private readonly maxUnresolved: number;
  private running: Promise<IngestionReport> | null = null;

  constructor(private readonly deps: IngestionDependencies) {
    this.level = deps.level ?? DEFAULT_SERVICE_LEVEL;
    this.alerter = deps.alerter ?? new ConsoleAlerter();
    this.basis = deps.basis ?? NFLVERSE_BASIS;
    this.now = deps.now ?? (() => new Date());
    this.maxUnresolved = deps.maxUnresolvedRecorded ?? 250;
  }

  /**
   * One ingestion at a time.
   *
   * Two concurrent runs would race on the same rename, and the loser's feed would be the one that
   * survives regardless of which fetched more recent data. The schedule fires from several triggers,
   * so overlap is expected rather than hypothetical.
   */
  ingest(season: string, week: number, signal?: AbortSignal): Promise<IngestionReport> {
    if (this.running) return this.running;
    const job = this.perform(season, week, signal).finally(() => { this.running = null; });
    this.running = job;
    return job;
  }

  private async perform(season: string, week: number, signal?: AbortSignal): Promise<IngestionReport> {
    const startedAt = this.now().toISOString();
    const started = Date.now();
    const errors: string[] = [];
    const derivations: DerivationNote[] = [];
    const sink: WeekSink = { derivations, byeConflicts: 0 };

    const finish = (partial: Partial<IngestionReport> & Pick<IngestionReport, 'status'>): IngestionReport => {
      const base: Omit<IngestionReport, 'breaches'> = {
        season, week, startedAt, finishedAt: this.now().toISOString(), durationMs: Date.now() - started,
        provenance: null, players: 0, omitted: { noProjection: 0 },
        identity: { total: 0, resolved: 0, rate: 0, byMethod: { 'cross-id': 0, 'team-defense': 0, 'name-team-position': 0, 'name-position': 0 } },
        unresolved: [], unresolvedTotal: 0, coverage: null, derivations,
        schema: { valid: false, error: null }, scenarios: { supported: this.deps.projections.capabilities.scenarios === 'floor-ceiling', withFloor: 0, withCeiling: 0 },
        errors, ...partial,
      };
      return { ...base, breaches: evaluateServiceLevel(base, this.level, this.now().getTime()) };
    };

    let report: IngestionReport;
    try {
      // The identity map is the one reference fetch that cannot degrade: without it every commercial
      // player id is unmappable, and the run would report a total identity failure as a data problem.
      const [fetched, identityMap, sleeperPlayers] = await Promise.all([
        this.deps.projections.fetchWeek(season, week, signal),
        this.deps.reference.identityMap(season, signal),
        this.deps.sleeperPlayers(),
      ]);
      derivations.push(...(fetched.notes ?? []));

      // Byes and injury reports enrich a feed that is still useful without them, so a failure here is
      // recorded and the run continues rather than discarding a complete set of projections.
      const [byes, injuries] = await Promise.all([
        this.deps.reference.byeWeeks(season, signal).catch(error => { errors.push(`Bye weeks unavailable: ${message(error)}`); return null; }),
        this.deps.reference.injuries(season, week, signal).catch(error => { errors.push(`Injury reports unavailable: ${message(error)}`); return null; }),
      ]);

      const resolution = resolveIdentities(fetched.players.map(player => player.identity), identityMap.links, sleeperPlayers);
      const bySleeperId = new Map(resolution.resolved.map(entry => [entry.providerId, entry.sleeperId]));
      const directory = new Map(sleeperPlayers.map(player => [player.id, player]));
      const officialInjuries = new Map((injuries?.reports ?? []).flatMap(report => report.crossIds.gsis ? [[report.crossIds.gsis, report.injury] as const] : []));

      const supplied: Partial<Record<Family, Set<string>>> = {};
      const derivedKeys = new Set<string>();
      const signals: PlayerSignal[] = [];
      let noProjection = 0; let withFloor = 0; let withCeiling = 0;

      for (const player of fetched.players) {
        const sleeperId = bySleeperId.get(player.identity.providerId);
        if (!sleeperId) continue;
        const sleeperPlayer = directory.get(sleeperId)!;
        const family = familyOf(sleeperPlayer);
        const team = normalizeTeam(player.identity.team ?? sleeperPlayer.team);
        const byeWeek = team && byes ? byes.byes[team] : undefined;

        const weeks = player.weeks.map(source => this.weeklyForecast(source, family, byeWeek === source.week, sink));
        const usable = weeks.filter((forecast): forecast is WeeklyForecast => forecast !== null);
        if (!usable.length) { noProjection += 1; continue; }
        withFloor += usable.filter(forecast => forecast.floorStats !== undefined).length;
        withCeiling += usable.filter(forecast => forecast.ceilingStats !== undefined).length;

        const injury = mergeInjury(player.injury, player.identity.crossIds.gsis ? officialInjuries.get(player.identity.crossIds.gsis) : undefined);
        const restOfSeason = player.restOfSeason && Object.keys(player.restOfSeason.stats).length ? player.restOfSeason : undefined;

        signals.push({
          playerId: sleeperId,
          weeks: usable,
          ...(restOfSeason ? { dynastyStats: restOfSeason.stats } : {}),
          ...(injury?.status !== undefined ? { injuryStatus: injury.status } : {}),
          ...(injury?.unavailableThroughWeek != null ? { unavailableThroughWeek: injury.unavailableThroughWeek } : {}),
          ...(player.role ? { role: player.role } : {}),
          ...(player.recentTargets?.length ? { recentTargets: player.recentTargets } : {}),
          ...(player.age !== undefined ? { age: player.age } : {}),
        });

        if (family) {
          const keys = supplied[family] ?? new Set<string>();
          for (const forecast of usable) {
            for (const stat of Object.keys(forecast.stats)) keys.add(stat);
            if (forecast.kicker) { for (const stat of KICKER_IMPLIED_KEYS) { keys.add(stat); if (stat === 'fgm_50_59' || stat === 'fgm_60p') derivedKeys.add(stat); } }
            if (forecast.defense) {
              for (const stat of DEFENSE_IMPLIED_KEYS) keys.add(stat);
              for (const stat of DEFENSE_IMPLIED_KEYS) if (stat.startsWith('pts_allow') || stat.startsWith('yds_allow')) derivedKeys.add(stat);
              if (forecast.defense.specialTeams) for (const stat of teamSpecialTeamsKeys) keys.add(stat);
            }
            if (forecast.specialTeams) for (const stat of individualSpecialTeamsKeys(forecast.specialTeams.coverage)) keys.add(stat);
          }
          supplied[family] = keys;
        }
      }

      const provenance: FeedProvenance = {
        season, week,
        sourceName: `${this.deps.projections.source.name} + ${this.deps.reference.source.name}`,
        sourceTimestamp: fetched.sourceTimestamp,
        ingestedAt: this.now().toISOString(),
        licenses: [this.deps.projections.source, this.deps.reference.source],
        contributions: [
          { source: this.deps.projections.source.name, sourceTimestamp: fetched.sourceTimestamp, role: 'projections' },
          { source: this.deps.reference.source.name, sourceTimestamp: identityMap.sourceTimestamp, role: 'reference' },
        ],
      };

      if (sink.byeConflicts) errors.push(`${sink.byeConflicts} weekly projections were non-zero for a week their team is idle; the schedule was treated as authoritative and those weeks were zeroed.`);

      const candidate: WaiverSignals = { season, week, source: provenance.sourceName, updatedAt: fetched.sourceTimestamp, players: signals };
      const coverage = await this.coverage(supplied, derivedKeys, errors);

      let schema: IngestionReport['schema'];
      try { parseWaiverSignals(candidate); schema = { valid: true, error: null }; }
      catch (error) { schema = { valid: false, error: message(error) }; }

      const shared = {
        provenance, players: signals.length, omitted: { noProjection: noProjection },
        identity: resolution.stats, unresolved: cap(resolution.unresolved, this.maxUnresolved),
        unresolvedTotal: resolution.unresolved.length, coverage, schema,
        scenarios: { supported: this.deps.projections.capabilities.scenarios === 'floor-ceiling', withFloor, withCeiling },
      };

      if (!schema.valid) {
        report = finish({ status: 'rejected', ...shared });
      } else {
        report = finish({ status: 'published', ...shared });
        // The report is written with the feed it describes, so the two can never disagree about which
        // ingestion produced the projections a manager is looking at.
        await this.deps.store.publish({ provenance, feed: candidate, report });
      }
    } catch (error) {
      errors.push(message(error));
      report = finish({ status: 'failed', schema: { valid: false, error: null } });
    }

    if (report.breaches.length || report.status !== 'published') {
      await this.alerter.alert({
        season, week, status: report.status,
        severity: report.status === 'failed' ? 'critical' : highestSeverity(report.breaches),
        breaches: report.breaches, report,
        ...(report.status === 'failed' ? { error: errors[errors.length - 1] } : {}),
      });
    }
    return report;
  }

  /**
   * One provider week becomes one feed week, or nothing.
   *
   * A week with no statistics and no position contract is dropped rather than emitted as an empty
   * stat line: the schema would refuse it, and zero-filling it would assert a projection of zero for
   * a player nobody projected. A bye is the one case where zeroes are asserted, because on a bye the
   * player genuinely scores nothing, and the scoring boundary requires an explicit flag to say so.
   *
   * When the schedule and the projection disagree — a non-zero line for a week the team is idle —
   * the schedule wins. A projection is an opinion about a game; the schedule is whether the game
   * exists. The disagreement is counted and reported rather than resolved silently, because a source
   * projecting through a bye is usually a sign its week numbering has slipped.
   */
  private weeklyForecast(source: ProviderWeekProjection, family: Family | null, onBye: boolean, sink: WeekSink): WeeklyForecast | null {
    const bye = onBye || source.bye === true;
    if (bye) {
      if (Object.values(source.stats).some(amount => amount !== 0)) sink.byeConflicts += 1;
      const stats = { ...(family ? BYE_LINES[family] : {}), ...Object.fromEntries(Object.keys(source.stats).map(stat => [stat, 0])) };
      return Object.keys(stats).length ? { week: source.week, stats, bye: true } : null;
    }

    const forecast: WeeklyForecast = { week: source.week, stats: { ...source.stats }, bye: false };
    if (source.opponent) forecast.opponent = source.opponent;
    if (source.opportunity) forecast.opportunity = source.opportunity;

    for (const [scenario, statKey, kickerKey, defenseKey] of [
      ['stats', 'stats', 'kicker', 'defense'], ['floorStats', 'floorStats', 'floorKicker', 'floorDefense'], ['ceilingStats', 'ceilingStats', 'ceilingKicker', 'ceilingDefense'],
    ] as const) {
      const line = scenario === 'stats' ? source.stats : source[scenario];
      const kicker = source[kickerKey]; const defense = source[defenseKey];
      if (scenario !== 'stats' && line) forecast[statKey] = { ...line };
      if (kicker) {
        const derived = deriveKickerForecast(kicker, this.basis);
        forecast[kickerKey] = derived.value; sink.derivations.push(...derived.notes);
        // Each position contract requires its own raw stat scenario alongside it; the contract's
        // counts live in the kicker object, so an empty companion line is the honest placeholder.
        if (forecast[statKey] === undefined) forecast[statKey] = {};
      }
      if (defense) {
        const derived = deriveDefenseForecast(defense, this.basis);
        forecast[defenseKey] = derived.value; sink.derivations.push(...derived.notes);
        if (forecast[statKey] === undefined) forecast[statKey] = {};
      }
    }
    if (source.specialTeams) forecast.specialTeams = source.specialTeams;

    const empty = Object.keys(forecast.stats).length === 0 && !forecast.kicker && !forecast.defense && !forecast.specialTeams;
    return empty ? null : forecast;
  }

  /** Coverage is relative to one league's rules; without a live snapshot it is not assessable. */
  private async coverage(supplied: Partial<Record<Family, Set<string>>>, derived: Set<string>, errors: string[]): Promise<CoverageReport | null> {
    if (!this.deps.scoring) return null;
    try {
      const scoring = await this.deps.scoring();
      if (!scoring?.actionable) { errors.push('Category coverage was not assessed: no league has a validated complete-live scoring snapshot.'); return null; }
      return assessCoverage(scoring, supplied, derived);
    } catch (error) { errors.push(`Category coverage could not be assessed: ${message(error)}`); return null; }
  }
}

/** Per-run accumulators threaded through week assembly, so one pass reports everything it noticed. */
interface WeekSink { derivations: DerivationNote[]; byeConflicts: number }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cap = <T>(values: T[], limit: number) => (values.length <= limit ? values : values.slice(0, limit));

/**
 * Two reports on the same player, reconciled toward caution.
 *
 * The official game-status report and a commercial feed disagree routinely, usually because one has
 * not caught up. The longer absence wins because acting on the shorter one starts a player who does
 * not play, while acting on the longer one costs a bench slot; and the status text comes from
 * whichever report was revised more recently, so a downgrade is not masked by a stale designation.
 */
export function mergeInjury(provider: ProviderInjury | null, official: ProviderInjury | undefined): ProviderInjury | null {
  if (!provider) return official ?? null;
  if (!official) return provider;
  const providerAt = Date.parse(provider.reportedAt); const officialAt = Date.parse(official.reportedAt);
  const newer = Number.isFinite(officialAt) && (!Number.isFinite(providerAt) || officialAt >= providerAt) ? official : provider;
  const windows = [provider.unavailableThroughWeek, official.unavailableThroughWeek].filter((week): week is number => week != null);
  return {
    status: newer.status, designation: newer.designation,
    practiceStatus: official.practiceStatus ?? provider.practiceStatus,
    unavailableThroughWeek: windows.length ? Math.max(...windows) : null,
    reportedAt: newer.reportedAt,
  };
}

export type { IngestionReport } from './service-level.js';
export type { IdentityResolution, UnresolvedIdentity };
