import type { League } from '@sleeper/domain';
import { currentNflWeek } from '../providers/configure.js';
import type { LeagueConnection } from '../store.js';

/**
 * Which season and week a connected league should be synchronized for.
 *
 * Three sources disagree often enough that picking between them has to be deliberate. The league's own
 * `settings.leg` is what Sleeper itself considers the current week and is authoritative while the
 * league is playing the season the calendar is in. The calendar week derived from the Labor Day anchor
 * is the fallback before a league has ever been synchronized, and during the gap where a league's
 * settings have not rolled over yet. The connection's persisted week is what a finished season keeps,
 * because a 2024 league's week 14 never becomes week 15 again.
 *
 * Every path is clamped into the regular season and can never produce `NaN`: a week is about to be
 * interpolated into an upstream URL, and a wrong one silently synchronizes the wrong matchups.
 */

export const FIRST_WEEK = 1;
export const FINAL_WEEK = 18;

export type WeekSource = 'league-settings' | 'calendar' | 'persisted' | 'final-week';
export interface SyncTarget { season: string; week: number; source: WeekSource; }

const season = (value: string | null | undefined) => (typeof value === 'string' && /^\d{4}$/.test(value.trim()) ? value.trim() : null);
const week = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= FIRST_WEEK && value <= FINAL_WEEK ? value : null);
const clamp = (value: number) => Math.min(FINAL_WEEK, Math.max(FIRST_WEEK, Math.round(value)));

export interface SyncTargetInput {
  league?: League | null;
  connection?: LeagueConnection | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export function resolveSyncTarget({ league, connection, now = new Date(), env = process.env }: SyncTargetInput): SyncTarget {
  const calendar = currentNflWeek(now, env);
  const leagueSeason = season(league?.season) ?? season(connection?.season);
  const target = leagueSeason ?? calendar.season;
  // A league that has already rolled to a season the calendar has not reached is in its pre-season:
  // week 1 is the only week that exists for it, and the calendar's week belongs to the season ending.
  if (Number(target) > Number(calendar.season)) return { season: target, week: FIRST_WEEK, source: 'calendar' };
  if (Number(target) < Number(calendar.season)) {
    const held = week(connection?.week) ?? week(league?.settings?.leg);
    return held ? { season: target, week: held, source: 'persisted' } : { season: target, week: FINAL_WEEK, source: 'final-week' };
  }
  const leg = week(league?.settings?.leg);
  return leg ? { season: target, week: leg, source: 'league-settings' } : { season: target, week: clamp(calendar.week), source: 'calendar' };
}

/**
 * Whether a league can no longer produce new observations.
 *
 * Both signals are required to be conservative in the right direction: `status` alone would archive a
 * league Sleeper marks complete during the same season's playoffs, and the season alone would keep
 * synchronizing an abandoned league forever. A league that has never been synchronized is unknown
 * rather than historical — nothing is archived on the strength of missing data.
 */
export function leagueIsHistorical(league: League | null | undefined, now = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  const leagueSeason = season(league?.season);
  if (!leagueSeason) return false;
  const calendar = currentNflWeek(now, env);
  if (Number(leagueSeason) < Number(calendar.season)) return true;
  return leagueSeason === calendar.season && league?.status === 'complete' && currentNflWeek(now, env).week >= FINAL_WEEK;
}
