import type { EmpiricalBasis } from './derivation.js';
import { NFLVERSE_BASIS } from './derivation.js';
import { ProviderHttpClient, requireCredential } from './http.js';
import { providerHttpOptions } from '../config/upstream.js';
import type {
  ProjectionProvider, ProviderCapabilities, ProviderDefenseLine, ProviderFetch, ProviderIdentity,
  ProviderKickerLine, ProviderPlayerProjection, ProviderWeekProjection, SourceLicense,
} from './provider.js';

/**
 * SportsDataIO NFL projections driver.
 *
 * Chosen because its terms are published, priced and explicitly permit use inside an application,
 * which the alternatives with comparable coverage do not: ESPN and Yahoo's fantasy endpoints are
 * undocumented and their terms forbid this, and Sleeper's own projections endpoint is undocumented
 * and therefore out of scope for this application by its own product rules.
 *
 * The licence permits *use* but not redistribution, so nothing this driver returns is ever served to
 * a browser. It exists to be turned into league-scored points, which are this application's own
 * output — the same boundary `docs/product-scope.md` already draws around Sleeper's data.
 */

const BASE = 'https://api.sportsdata.io/v3/nfl';

export const SPORTSDATAIO_LICENSE: SourceLicense = Object.freeze({
  name: 'SportsDataIO NFL',
  license: 'SportsDataIO commercial data licence (per-subscription); use permitted, redistribution of raw records prohibited',
  licenseUrl: 'https://sportsdata.io/terms',
  attribution: 'Projection and injury data provided by SportsDataIO.',
  redistributable: false,
  credentialEnvVar: 'SPORTSDATAIO_API_KEY',
});

/**
 * What this source can express. Two shortfalls are structural and are declared rather than papered
 * over: it publishes no floor or ceiling stat scenarios at all, and it publishes mean points and
 * yards allowed rather than distributions over Sleeper's tiers.
 */
export const SPORTSDATAIO_CAPABILITIES: ProviderCapabilities = Object.freeze({
  scenarios: 'mean-only',
  restOfSeason: true,
  opportunity: true,
  kickerDistanceBands: 'combined-50-plus',
  defenseTierDistributions: false,
  individualSpecialTeams: false,
});

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isArray = (value: unknown) => Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** Only non-zero statistics are emitted: a zero for a rule the source does not model would read as a forecast. */
const positive = (entries: Array<[string, number]>) => Object.fromEntries(entries.filter(([, amount]) => amount > 0));

interface RawProjection { [key: string]: unknown }

/** Season-long projections carry the same stat names; only the endpoint and horizon differ. */
const statLine = (row: RawProjection): Record<string, number> => positive([
  ['pass_yd', num(row.PassingYards)], ['pass_td', num(row.PassingTouchdowns)], ['pass_int', num(row.PassingInterceptions)], ['pass_2pt', num(row.PassingTwoPointConversions)],
  ['rush_yd', num(row.RushingYards)], ['rush_td', num(row.RushingTouchdowns)], ['rush_2pt', num(row.RushingTwoPointConversions)],
  ['rec', num(row.Receptions)], ['rec_yd', num(row.ReceivingYards)], ['rec_td', num(row.ReceivingTouchdowns)], ['rec_2pt', num(row.ReceivingTwoPointConversions)],
  ['fum_lost', num(row.FumblesLost)],
]);

/**
 * The source publishes field goals *made* by distance but attempts only in total. Attempts per band
 * are recovered by inverting each band's empirical make rate and rescaling to the published total, so
 * the misses Sleeper charges at `fgmiss` land at plausible distances instead of all in one band.
 */
function kickerLine(row: RawProjection, basis: EmpiricalBasis): ProviderKickerLine | undefined {
  const madeByBand = {
    '0_19': num(row.FieldGoalsMade0to19), '20_29': num(row.FieldGoalsMade20to29), '30_39': num(row.FieldGoalsMade30to39),
    '40_49': num(row.FieldGoalsMade40to49), '50p': num(row.FieldGoalsMade50Plus),
  };
  const totalAttempts = num(row.FieldGoalsAttempted);
  const totalMade = Object.values(madeByBand).reduce((a, b) => a + b, 0);
  if (totalAttempts <= 0 && totalMade <= 0 && num(row.ExtraPointsAttempted) <= 0) return undefined;

  // Longer bands convert less often, so an equal-accuracy split would understate long-range misses.
  const RATES: Record<keyof typeof madeByBand, number> = { '0_19': 0.98, '20_29': 0.97, '30_39': 0.92, '40_49': 0.83, '50p': basis.makeRate5059 * basis.longAttemptShare5059 + basis.makeRate60p * (1 - basis.longAttemptShare5059) };
  const implied = Object.fromEntries(Object.entries(madeByBand).map(([band, made]) => [band, made / RATES[band as keyof typeof RATES]])) as Record<keyof typeof madeByBand, number>;
  const impliedTotal = Object.values(implied).reduce((a, b) => a + b, 0);
  const scale = impliedTotal > 0 && totalAttempts > 0 ? totalAttempts / impliedTotal : 1;

  const fieldGoals = Object.fromEntries(Object.entries(madeByBand).map(([band, made]) => {
    // Attempts can never fall below makes, whatever the rescaling implies for a lopsided week.
    const attempts = Math.max(made, implied[band as keyof typeof implied] * scale);
    return [band, { attempts, makes: made }];
  })) as ProviderKickerLine['fieldGoals'];

  const patAttempts = num(row.ExtraPointsAttempted); const patMade = num(row.ExtraPointsMade);
  return { fieldGoals, pat: { makes: patMade, misses: Math.max(0, patAttempts - patMade) }, misses: Math.max(0, totalAttempts - totalMade) };
}

const defenseLine = (row: RawProjection): ProviderDefenseLine => ({
  sacks: num(row.Sacks), interceptions: num(row.Interceptions), forcedFumbles: num(row.FumblesForced),
  fumbleRecoveries: num(row.FumblesRecovered), safeties: num(row.Safeties), blockedKicks: num(row.BlockedKicks),
  defensiveTouchdowns: num(row.DefensiveTouchdowns),
  pointsAllowed: num(row.PointsAllowed), yardsAllowed: num(row.OpponentTotalYards ?? row.YardsAllowed),
  specialTeams: { touchdowns: num(row.SpecialTeamsTouchdowns), forcedFumbles: 0, fumbleRecoveries: 0 },
});

const identityOf = (row: RawProjection, fallbackId: string): ProviderIdentity => ({
  providerId: String(row.PlayerID ?? fallbackId),
  name: text(row.Name) ?? text(row.ShortName) ?? fallbackId,
  team: text(row.Team),
  position: text(row.FantasyPosition) ?? text(row.Position),
  // `fantasydata` is the source's own namespace, carried so an identity map keyed on it can match
  // directly rather than falling back to a name comparison.
  crossIds: definedIds({ gsis: text(row.GsisPlayerID), sportradar: text(row.SportRadarPlayerID), fantasydata: text(String(row.PlayerID ?? '')) }),
});
const definedIds = (values: Record<string, string | null>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));

export interface SportsDataIoOptions { fetcher?: typeof fetch; baseUrl?: string; apiKey?: string; basis?: EmpiricalBasis; timeoutMs?: number; maxRetries?: number; }

export class SportsDataIoProvider implements ProjectionProvider {
  readonly source = SPORTSDATAIO_LICENSE;
  readonly capabilities = SPORTSDATAIO_CAPABILITIES;
  private readonly http: ProviderHttpClient;
  private readonly baseUrl: string;
  private readonly basis: EmpiricalBasis;
  private readonly apiKey: string;

  constructor(options: SportsDataIoOptions = {}) {
    // Ingestion runs on a schedule with nobody waiting, so it takes the shared 'background' budget.
    this.http = new ProviderHttpClient(this.source.name, options.fetcher, providerHttpOptions('background', { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries }));
    this.baseUrl = options.baseUrl ?? BASE;
    this.basis = options.basis ?? NFLVERSE_BASIS;
    this.apiKey = options.apiKey ?? requireCredential(this.source.credentialEnvVar!);
  }

  /** The credential travels as a header, never in the path: query strings reach proxy and error logs. */
  private get<T>(path: string, signal?: AbortSignal) {
    return this.http.getJson<T>(`${this.baseUrl}${path}`, isArray, { 'Ocp-Apim-Subscription-Key': this.apiKey }, signal);
  }

  async fetchWeek(season: string, week: number, signal?: AbortSignal): Promise<ProviderFetch> {
    const forWeek = `${encodeURIComponent(season)}/${encodeURIComponent(String(week))}`;
    const [players, defenses, injuries, restOfSeason] = await Promise.all([
      this.get<RawProjection[]>(`/projections/json/PlayerGameProjectionStatsByWeek/${forWeek}`, signal),
      this.get<RawProjection[]>(`/projections/json/FantasyDefenseProjectionsByGame/${forWeek}`, signal),
      this.get<RawProjection[]>(`/scores/json/Injuries/${forWeek}`, signal),
      this.get<RawProjection[]>(`/projections/json/PlayerSeasonProjectionStats/${encodeURIComponent(season)}`, signal),
    ]);

    const injuryByPlayer = new Map(injuries.filter(object).map(row => [String(row.PlayerID), row]));
    const seasonByPlayer = new Map(restOfSeason.filter(object).map(row => [String(row.PlayerID), row]));
    const weeksPlayed = Math.max(1, week - 1);
    const remaining = Math.max(1, 18 - week + 1);

    const offensive = players.filter(object).map<ProviderPlayerProjection>(row => {
      const identity = identityOf(row, String(row.PlayerID ?? ''));
      const kicker = identity.position === 'K' ? kickerLine(row, this.basis) : undefined;
      const week1: ProviderWeekProjection = {
        week, stats: statLine(row), opponent: text(row.Opponent), bye: text(row.Opponent) === null && num(row.Games) === 0,
        ...(kicker ? { kicker } : {}),
        ...(num(row.ReceivingTargets) > 0 ? { opportunity: { targets: num(row.ReceivingTargets) } } : {}),
      };
      const seasonRow = seasonByPlayer.get(identity.providerId);
      // The season projection is a full-season total; a *future typical week* is what the dynasty and
      // remaining-season contracts consume, so the weeks already played are removed before dividing.
      const perWeek = seasonRow ? scaleStats(statLine(seasonRow), remaining, weeksPlayed, statLine(row)) : undefined;
      return {
        identity, weeks: [week1],
        ...(perWeek ? { restOfSeason: { stats: perWeek, weeksRemaining: remaining } } : {}),
        injury: injuryRecord(injuryByPlayer.get(identity.providerId), week),
      };
    });

    const units = defenses.filter(object).map<ProviderPlayerProjection>(row => ({
      identity: { providerId: `DEF:${text(row.Team) ?? ''}`, name: `${text(row.Team) ?? 'Unknown'} defense`, team: text(row.Team), position: 'DEF', crossIds: {} },
      weeks: [{ week, stats: {}, defense: defenseLine(row), opponent: text(row.Opponent) }],
      injury: null,
    }));

    return {
      sourceTimestamp: latestTimestamp([...players, ...defenses, ...injuries]) ?? new Date().toISOString(),
      players: [...offensive, ...units],
      notes: [{
        field: 'kicker.fieldGoals.attempts',
        method: 'attempts per band recovered from published makes by inverting empirical band make rates, rescaled to the published attempt total',
        basis: this.basis.label,
        explanation: 'The source publishes field goals made by distance but attempts only in total, and Sleeper charges fgmiss on attempts.',
      }],
    };
  }
}

/**
 * A source timestamp taken from the data, not from the clock.
 *
 * `Updated` is when the source last revised the row. Falling back to our own clock would make a feed
 * that has not moved in three days look freshly published, which is exactly the failure the staleness
 * threshold exists to catch.
 */
function latestTimestamp(rows: RawProjection[]): string | null {
  const times = rows.filter(object).map(row => Date.parse(String(row.Updated ?? row.Created ?? ''))).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Season totals minus what is already played, divided by the weeks that remain. */
function scaleStats(seasonTotals: Record<string, number>, remaining: number, weeksPlayed: number, thisWeek: Record<string, number>): Record<string, number> {
  const entries = Object.entries(seasonTotals).map(([stat, total]) => {
    const played = (thisWeek[stat] ?? 0) * weeksPlayed;
    return [stat, Math.max(0, (total - played) / remaining)] as const;
  });
  return Object.fromEntries(entries.filter(([, amount]) => amount > 0));
}

const OUT_DESIGNATIONS = new Set(['out', 'ir', 'injured reserve', 'doubtful', 'pup', 'nfi', 'suspended']);
/**
 * An availability *window*, not a label.
 *
 * `unavailableThroughWeek` is what a manager plans around. It is set only from a designation that
 * actually rules a player out; "Questionable" is carried as a status because it is real information,
 * but it is not an absence, and treating it as one would bench a player the source expects to play.
 */
function injuryRecord(row: RawProjection | undefined, week: number): ProviderPlayerProjection['injury'] {
  if (!row) return null;
  const status = text(row.Status) ?? text(row.InjuryStatus);
  const designation = text(row.DeclaredInactive) === 'true' ? 'Inactive' : status;
  const out = status ? OUT_DESIGNATIONS.has(status.toLowerCase()) : false;
  return {
    status, designation, practiceStatus: text(row.Practice) ?? text(row.PracticeDescription),
    unavailableThroughWeek: out ? week : null,
    reportedAt: text(row.Updated) ?? new Date().toISOString(),
  };
}
