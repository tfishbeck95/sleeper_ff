import { readFile } from 'node:fs/promises';

/** Raw baseline stat forecasts: the pipeline applies league scoring, role and matchup adjustments. */
export interface WeeklyForecast {
  week: number; stats: Record<string, number>;
  opponent?: string; bye?: boolean;
  /** 1 is neutral; use only for matchup effects not already in the baseline forecast. */
  matchupMultiplier?: number;
}
export interface PlayerSignal {
  playerId: string; weeks: WeeklyForecast[];
  /** Expected stat line in a future typical week, for dynasty retention value. */
  dynastyStats?: Record<string, number>;
  /** Trade valuation inputs supplied by the forecast source, not inferred NFL facts. */
  age?: number; expectedCareerYears?: number; uncertainty?: number; tradeEligible?: boolean;
  injuryStatus?: string | null; unavailableThroughWeek?: number;
  /** Fractions from 0 to 1. Omit if role changes are already included in baseline stats. */
  role?: { recentShare: number; previousShare: number; games: number };
  acquisitionEligible?: boolean; droppable?: boolean; eligibilityReason?: string;
}
export interface WaiverSignals {
  season: string; week: number; source: string; updatedAt: string;
  players: PlayerSignal[];
  /** Optional league-specific constraints supplied by a trusted rules adapter. */
  leagues?: Record<string, {
    blockedAddIds?: string[]; protectedDropIds?: string[];
    positionLimits?: Record<string, number>;
    /** Authoritative remaining balances, including transfers/commissioner adjustments. */
    faabRemaining?: Record<string, number>;
    /** Complete upcoming rookie draft definitions; native picks are overlaid with synced transfers. */
    rookieDrafts?: Array<{ season: string; rounds: number }>;
    tradeStrategies?: Record<string, 'contender' | 'balanced' | 'rebuilder'>;
    protectedTradeIds?: string[];
  }>;
}
export interface WaiverSignalProvider { load(season: string, week: number): Promise<WaiverSignals | null> }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const weekNumber = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 1 && v <= 18;
const stats = (v: unknown) => object(v) && Object.keys(v).length > 0 && Object.values(v).every(finite);
const ids = (v: unknown) => Array.isArray(v) && v.every(id => typeof id === 'string');
export function parseWaiverSignals(value: unknown): WaiverSignals {
  if (!object(value) || typeof value.season !== 'string' || !/^\d{4}$/.test(value.season) || !weekNumber(value.week) || typeof value.source !== 'string' || !value.source.trim() || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.players)) throw new Error('Invalid waiver signal metadata.');
  const seen = new Set<string>();
  for (const p of value.players) {
    if (!object(p) || typeof p.playerId !== 'string' || !p.playerId || seen.has(p.playerId) || !Array.isArray(p.weeks)) throw new Error('Invalid or duplicate waiver player signal.');
    seen.add(p.playerId);
    const weeks = new Set<number>();
    for (const w of p.weeks) {
      if (!object(w) || !weekNumber(w.week) || weeks.has(w.week) || !stats(w.stats) || (w.opponent !== undefined && typeof w.opponent !== 'string') || (w.bye !== undefined && typeof w.bye !== 'boolean') || (w.matchupMultiplier !== undefined && (!finite(w.matchupMultiplier) || w.matchupMultiplier < .5 || w.matchupMultiplier > 1.5))) throw new Error('Invalid or duplicate weekly waiver forecast.');
      weeks.add(w.week);
    }
    if (p.dynastyStats !== undefined && !stats(p.dynastyStats)) throw new Error('Invalid dynasty forecast.');
    if (p.age !== undefined && (!finite(p.age) || p.age < 18 || p.age > 60)) throw new Error('Invalid player age.');
    if (p.expectedCareerYears !== undefined && (!finite(p.expectedCareerYears) || p.expectedCareerYears <= 0 || p.expectedCareerYears > 25)) throw new Error('Invalid career horizon.');
    if (p.uncertainty !== undefined && (!finite(p.uncertainty) || p.uncertainty < 0 || p.uncertainty > 1)) throw new Error('Invalid trade uncertainty.');
    if (p.tradeEligible !== undefined && typeof p.tradeEligible !== 'boolean') throw new Error('Invalid trade eligibility.');
    if (p.role !== undefined && (!object(p.role) || !finite(p.role.recentShare) || p.role.recentShare < 0 || p.role.recentShare > 1 || !finite(p.role.previousShare) || p.role.previousShare < 0 || p.role.previousShare > 1 || !finite(p.role.games) || !Number.isInteger(p.role.games) || p.role.games < 1)) throw new Error('Invalid role trend.');
    if (p.unavailableThroughWeek !== undefined && !weekNumber(p.unavailableThroughWeek)) throw new Error('Invalid injury return week.');
    if (p.injuryStatus !== undefined && p.injuryStatus !== null && typeof p.injuryStatus !== 'string') throw new Error('Invalid injury status.');
    for (const key of ['acquisitionEligible', 'droppable']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error('Invalid acquisition constraint.');
    if (p.eligibilityReason !== undefined && typeof p.eligibilityReason !== 'string') throw new Error('Invalid eligibility reason.');
  }
  if (value.leagues !== undefined) {
    if (!object(value.leagues)) throw new Error('Invalid league constraints.');
    for (const policy of Object.values(value.leagues)) {
      if (!object(policy)) throw new Error('Invalid league constraints.');
      for (const key of ['blockedAddIds', 'protectedDropIds', 'protectedTradeIds']) if (policy[key] !== undefined && !ids(policy[key])) throw new Error('Invalid player constraints.');
      if (policy.rookieDrafts !== undefined && (!Array.isArray(policy.rookieDrafts) || policy.rookieDrafts.length > 5 || policy.rookieDrafts.some(d => !object(d) || typeof d.season !== 'string' || !/^\d{4}$/.test(d.season) || !finite(d.rounds) || !Number.isInteger(d.rounds) || d.rounds < 1 || d.rounds > 10) || new Set(policy.rookieDrafts.map(d => d.season)).size !== policy.rookieDrafts.length)) throw new Error('Invalid rookie draft inventory.');
      if (policy.tradeStrategies !== undefined && (!object(policy.tradeStrategies) || Object.values(policy.tradeStrategies).some(s => !['contender', 'balanced', 'rebuilder'].includes(String(s))))) throw new Error('Invalid trade strategy.');
      for (const key of ['positionLimits', 'faabRemaining']) if (policy[key] !== undefined && (!object(policy[key]) || !Object.values(policy[key]).every(v => finite(v) && Number.isInteger(v) && v >= 0))) throw new Error('Invalid league limits.');
    }
  }
  return value as unknown as WaiverSignals;
}
/** No undocumented Sleeper endpoints or fabricated forecasts. File can be replaced atomically by a data job. */
export class FileWaiverSignalProvider implements WaiverSignalProvider {
  constructor(private readonly path = process.env.WAIVER_SIGNALS_PATH) {}
  async load(season: string, week: number) {
    if (!this.path) return null;
    const parsed = parseWaiverSignals(JSON.parse(await readFile(this.path, 'utf8')));
    return parsed.season === season && parsed.week === week ? parsed : null;
  }
}
