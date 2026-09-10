import { ProviderHttpClient } from './http.js';
import type { IdentityLink, ProviderInjury, ReferenceDataProvider, SourceLicense } from './provider.js';

/**
 * nflverse reference-data driver: identity map, bye weeks and official injury reports.
 *
 * Kept separate from the projection source on purpose. The licence that permits forward projections
 * is a paid commercial one that forbids redistribution; the licence covering this data is CC BY 4.0,
 * which permits redistribution with attribution. Ingesting them through one interface would force the
 * stricter terms onto data that does not need them, and would make the identity map — the one piece
 * that must keep working when the paid subscription lapses — depend on that subscription.
 *
 * The identity map is DynastyProcess's `db_playerids`, the only openly licensed cross-reference that
 * carries Sleeper's own player ids. Without it there is no lawful way to turn a commercial source's
 * player into a Sleeper player except by name, which is exactly the guess `identity.ts` refuses.
 */

export const NFLVERSE_LICENSE: SourceLicense = Object.freeze({
  name: 'nflverse / DynastyProcess',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Player identity, schedule and injury data from nflverse and DynastyProcess, licensed CC BY 4.0.',
  redistributable: true,
  credentialEnvVar: null,
});

const IDENTITY_MAP_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
const SCHEDULE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const injuriesUrl = (season: string) => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${encodeURIComponent(season)}.csv`;

/**
 * Minimal RFC 4180 reader. Player names carry commas ("Odell Beckham, Jr.") and injury descriptions
 * carry quotes, so splitting on commas would corrupt exactly the rows identity matching depends on.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') { field += char; continue; }
      if (text[index + 1] === '"') { field += '"'; index += 1; continue; }
      quoted = false; continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = ''; rows.push(row); row = []; continue;
    }
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(entry => entry.some(value => value !== ''));
  if (!header) return [];
  return body.map(entry => Object.fromEntries(header.map((name, index) => [name.trim(), (entry[index] ?? '').trim()])));
}

const value = (row: Record<string, string>, key: string): string | null => (row[key] && row[key] !== 'NA' ? row[key] : null);

export interface NflverseOptions { fetcher?: typeof fetch; identityMapUrl?: string; scheduleUrl?: string; injuriesUrl?: (season: string) => string; timeoutMs?: number; maxRetries?: number; }

export class NflverseReferenceProvider implements ReferenceDataProvider {
  readonly source = NFLVERSE_LICENSE;
  private readonly http: ProviderHttpClient;
  private readonly urls: { identity: string; schedule: string; injuries: (season: string) => string };

  constructor(options: NflverseOptions = {}) {
    this.http = new ProviderHttpClient(this.source.name, options.fetcher, { timeoutMs: options.timeoutMs ?? 30_000, maxRetries: options.maxRetries });
    this.urls = { identity: options.identityMapUrl ?? IDENTITY_MAP_URL, schedule: options.scheduleUrl ?? SCHEDULE_URL, injuries: options.injuriesUrl ?? injuriesUrl };
  }

  /** Rows without a Sleeper id are dropped here: they cannot bridge anything and only dilute the map. */
  async identityMap(_season: string, signal?: AbortSignal) {
    const rows = parseCsv(await this.http.getText(this.urls.identity, {}, signal));
    const links = rows.flatMap<IdentityLink>(row => {
      const sleeperId = value(row, 'sleeper_id');
      if (!sleeperId) return [];
      return [{
        sleeperId,
        name: value(row, 'name') ?? value(row, 'merge_name') ?? '',
        team: value(row, 'team'),
        position: value(row, 'position'),
        crossIds: Object.fromEntries(([
          ['gsis', 'gsis_id'], ['sportradar', 'sportradar_id'], ['espn', 'espn_id'],
          ['yahoo', 'yahoo_id'], ['pfr', 'pfr_id'], ['fantasypros', 'fantasypros_id'], ['fantasydata', 'fantasydata_id'],
        ] as const).flatMap(([namespace, column]) => { const id = value(row, column); return id ? [[namespace, id] as const] : []; })),
      }];
    });
    return { sourceTimestamp: new Date().toISOString(), links };
  }

  /**
   * A bye is an absence, so it is read as one: the weeks a team does not appear in the schedule.
   * Deriving it from a "bye week" column would depend on a field the schedule does not always carry,
   * and would go stale the moment the league moves a game.
   */
  async byeWeeks(season: string, signal?: AbortSignal) {
    const rows = parseCsv(await this.http.getText(this.urls.schedule, {}, signal))
      .filter(row => row.season === season && (row.game_type ?? 'REG') === 'REG');
    const played = new Map<string, Set<number>>();
    const weeks = new Set<number>();
    for (const row of rows) {
      const week = Number(row.week);
      if (!Number.isInteger(week) || week < 1 || week > 18) continue;
      weeks.add(week);
      for (const team of [row.away_team, row.home_team]) {
        if (!team) continue;
        const seen = played.get(team) ?? new Set<number>();
        seen.add(week); played.set(team, seen);
      }
    }
    const byes: Record<string, number> = {};
    for (const [team, seen] of played) {
      const idle = [...weeks].sort((a, b) => a - b).find(week => !seen.has(week));
      if (idle !== undefined) byes[team] = idle;
    }
    return { sourceTimestamp: new Date().toISOString(), byes };
  }

  /**
   * The official game-status report, keyed by GSIS id so it joins to the identity map exactly rather
   * than by name. `report_status` is the designation that decides availability; practice status is
   * carried alongside it because a full participant listed as questionable is a different planning
   * problem from one who did not practise at all.
   */
  async injuries(season: string, week: number, signal?: AbortSignal) {
    const rows = parseCsv(await this.http.getText(this.urls.injuries(season), {}, signal))
      .filter(row => Number(row.week) === week);
    const reports = rows.map(row => {
      const status = value(row, 'report_status');
      const out = status ? ['out', 'doubtful'].includes(status.toLowerCase()) : false;
      const injury: ProviderInjury = {
        status, designation: status, practiceStatus: value(row, 'practice_status'),
        unavailableThroughWeek: out ? week : null,
        reportedAt: value(row, 'date_modified') ?? new Date().toISOString(),
      };
      const gsis = value(row, 'gsis_id');
      const crossIds: Record<string, string> = gsis ? { gsis } : {};
      return { crossIds, name: value(row, 'full_name') ?? '', team: value(row, 'team'), injury };
    });
    const stamps = reports.map(report => Date.parse(report.injury.reportedAt)).filter(Number.isFinite);
    return { sourceTimestamp: stamps.length ? new Date(Math.max(...stamps)).toISOString() : new Date().toISOString(), reports };
  }
}
