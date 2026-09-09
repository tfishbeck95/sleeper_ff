import { referenceScoring, scoringUnavailable, type ScoringConfiguration } from './scoring.js';
import type { League, RosterPosition, ScoringSetting } from './index.js';

export type LineupPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | 'DL' | 'LB' | 'DB' | 'IDP' | 'FLEX' | 'SUPER_FLEX' | 'REC_FLEX' | string;
export type LeagueFormat = 'dynasty' | 'keeper' | 'redraft';

export interface ScoringRules {
  configuration: ScoringConfiguration;
  actionable: boolean;
  settings: Readonly<Record<string, number>>;
  receptionPoints: number | null;
  receptionFormat: 'standard' | 'half-ppr' | 'ppr' | 'custom' | 'unknown';
  score(stats: Readonly<Record<string, number>>): { points: number; explanation: string };
}

export interface RosterRules {
  starters: RosterPosition[];
  benchSlots: number;
  reserveSlots: number;
  taxiSlots: number;
  eligiblePositions(slot: LineupPosition): string[];
}

export interface PlayoffRules {
  teams: number;
  startsWeek: number | null;
  rounds: number | null;
  twoWeekChampionship: boolean;
  reseed: boolean;
  matchupType: 'head-to-head' | 'median' | 'head-to-head-and-median';
}

export interface KeeperRules { enabled: boolean; count: number | null; }
export interface LeagueRules {
  scoring: ScoringRules;
  roster: RosterRules;
  format: LeagueFormat;
  keepers: KeeperRules;
  tradedDraftPicks: boolean;
  playoffs: PlayoffRules;
}

const FLEX: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'], IDP_FLEX: ['DL', 'LB', 'DB'],
};

export function interpretScoring(settings: readonly ScoringSetting[] | Readonly<Record<string, number>>, configuration?: ScoringConfiguration): ScoringRules {
  const map = Array.isArray(settings)
    ? Object.fromEntries((settings as readonly ScoringSetting[]).map(({ key, points }) => [key, points]))
    : { ...(settings as Readonly<Record<string, number>>) };
  const config = configuration ?? referenceScoring(map);
  const rates = config.settings ?? {};
  const receptionPoints = rates.rec ?? (config.kind === 'complete-live' ? 0 : null);
  const receptionFormat = receptionPoints === null ? 'unknown' : receptionPoints === 0 ? 'standard' : receptionPoints === .5 ? 'half-ppr' : receptionPoints === 1 ? 'ppr' : 'custom';
  return {
    settings: rates, configuration: config, actionable: config.kind === 'complete-live', receptionPoints, receptionFormat,
    score(stats) {
      if (config.kind !== 'complete-live') throw new Error('A validated complete live scoring configuration is required.');
      const contributions = Object.entries(stats).flatMap(([stat, amount]) => {
        const rate = rates[stat] ?? 0; const points = amount * rate;
        return points === 0 ? [] : [{ stat, amount, rate, points }];
      });
      const points = contributions.reduce((sum, value) => sum + value.points, 0);
      const explanation = contributions.length
        ? contributions.map(v => `${v.amount} ${v.stat} × ${v.rate} = ${v.points.toFixed(2)}`).join('; ')
        : 'No supplied statistics have a non-zero scoring rule.';
      return { points: Math.round(points * 100) / 100, explanation };
    },
  };
}

export function interpretRoster(positions: readonly (RosterPosition | string)[], settings: Readonly<Record<string, number>> = {}): RosterRules {
  const normalized = positions.map((value, slot) => typeof value === 'string' ? { position: value, slot } : value);
  const named = (name: string) => normalized.filter(value => value.position === name);
  const excluded = new Set(['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);
  return {
    starters: normalized.filter(value => !excluded.has(value.position)),
    benchSlots: named('BN').length + named('BENCH').length,
    reserveSlots: Math.max(named('IR').length + named('RESERVE').length, settings.reserve_slots ?? 0),
    taxiSlots: Math.max(named('TAXI').length, settings.taxi_slots ?? 0),
    eligiblePositions(slot) { return FLEX[slot] ? [...FLEX[slot]] : [slot]; },
  };
}

export function interpretLeagueRules(league: Pick<League, 'scoring' | 'scoringSettings' | 'rosterPositions' | 'settings' | 'previousLeagueId' | 'seasonType'>): LeagueRules {
  const settings = league.settings ?? {};
  const keeperCount = settings.keeper_count ?? settings.num_keepers;
  const dynasty = settings.type === 2 || settings.dynasty === 1 || settings.taxi_slots > 0;
  const format: LeagueFormat = dynasty ? 'dynasty' : settings.type === 1 || (keeperCount != null && keeperCount > 0) ? 'keeper' : 'redraft';
  const median = settings.league_average_match === 1;
  const playoffTeams = settings.playoff_teams ?? 0;
  return {
    scoring: interpretScoring(league.scoringSettings, league.scoring ?? (league.scoringSettings.length ? referenceScoring(Object.fromEntries(league.scoringSettings.map(s => [s.key, s.points]))) : scoringUnavailable())),
    roster: interpretRoster(league.rosterPositions, settings),
    format,
    keepers: { enabled: format === 'keeper', count: keeperCount ?? null },
    tradedDraftPicks: settings.disable_trades !== 1 && (format === 'dynasty' || settings.allow_draft_pick_trades === 1),
    playoffs: {
      teams: playoffTeams,
      startsWeek: settings.playoff_week_start ?? null,
      rounds: playoffTeams > 1 ? Math.ceil(Math.log2(playoffTeams)) : null,
      twoWeekChampionship: settings.playoff_round_type === 1,
      reseed: settings.playoff_seed_type === 1,
      matchupType: median ? 'head-to-head-and-median' : 'head-to-head',
    },
  };
}
