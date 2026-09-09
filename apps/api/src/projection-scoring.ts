import { normalizeDefenseStats, scoreDefense, unavailableDefense } from './defense.js';
import { normalizeKickerStats, scoreKicker, unavailableKicker } from './kicker.js';
import { scoreQuarterback, scaleQuarterback } from './quarterback.js';
import { normalizeSpecialTeamsStats, scaleSpecialTeams, withSpecialTeams } from './special-teams.js';
import { validateRushingSplit } from './waiver-signals.js';
import type {
  ForecastRejection, ForecastRejectionKind, NflPlayer, ScoredForecastSet, ScoredPlayerForecast,
  ScoredPoints, ScoredWeek, ScoringRules,
} from '@sleeper/domain';
import {
  INDIVIDUAL_SPECIAL_TEAMS_KEYS, INDIVIDUAL_SPECIAL_TEAMS_STATS, SPECIAL_TEAMS_CATEGORIES,
  TEAM_SPECIAL_TEAMS_KEYS, TEAM_SPECIAL_TEAMS_STATS, scoringSummary,
} from '@sleeper/domain';
import type { WeekOpportunity } from '@sleeper/domain';
import { opportunityProfile, weekOpportunity } from './opportunity.js';
import type { PlayerSignal, WaiverSignals, WeeklyForecast } from './waiver-signals.js';

/**
 * The lineup-analysis input boundary.
 *
 * Every ranking in this application consumes fantasy points produced here and nowhere else. A
 * forecast provider supplies raw projected statistics plus optional floor/ceiling raw-stat
 * scenarios; this module applies the synchronized league's own `ScoringRules` to each of them,
 * records the scoring snapshot and forecast timestamp on the result, and refuses any projection
 * whose player identity or raw-stat units cannot be validated. A refused projection is reported,
 * never defaulted to zero and never passed through as an unexplained points value.
 */

/** Keys a provider must never send: a pre-scored total cannot be re-derived under this league's rules. */
export const PRE_SCORED_KEYS: readonly string[] = ['points', 'projectedpoints', 'projected_points', 'fantasypoints', 'fantasy_points', 'fpts', 'pts', 'proj', 'projection', 'score'];
/** Injury designations that zero a forecast. Trade valuation additionally treats `retired` as absent. */
export const WAIVER_UNAVAILABLE_STATUSES: readonly string[] = ['out', 'ir', 'pup', 'suspended', 'inactive', 'injured reserve'];
export const TRADE_UNAVAILABLE_STATUSES: readonly string[] = [...WAIVER_UNAVAILABLE_STATUSES, 'retired'];

export interface AvailabilityPolicy {
  /**
   * `selected-week` matches waiver streaming: an injury designation with no supplied return week
   * zeroes only the selected week. `entire-horizon` matches trade valuation: the same designation
   * conservatively zeroes every forecast week. An explicit `unavailableThroughWeek` always applies.
   */
  policy: 'selected-week' | 'entire-horizon';
  selectedWeek?: number;
  statuses?: readonly string[];
}
export interface ScoreForecastsInput {
  rules: ScoringRules;
  signals: WaiverSignals;
  /** Synchronized Sleeper player directory. A forecast that does not resolve here is refused. */
  players: readonly NflPlayer[];
  /** Weeks the caller needs covered. A player missing one is refused, never zero-filled. */
  requiredWeeks?: readonly number[];
  availability?: AvailabilityPolicy;
  scoredAt?: Date;
}
/** A scored forecast plus the API-internal source records the ranking engines still need. */
export interface ScoredPlayer extends ScoredPlayerForecast {
  signal: PlayerSignal; player: NflPlayer;
}
export interface ScoredForecasts extends ScoredForecastSet {
  players: ScoredPlayer[];
  byPlayerId: Map<string, ScoredPlayer>;
}

const positionsOf = (player: NflPlayer) => player.fantasyPositions.length ? player.fantasyPositions : player.position ? [player.position] : [];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const roleMultiplier = (signal: PlayerSignal) => 1 + (signal.role ? clamp((signal.role.recentShare - signal.role.previousShare) * .5, -.15, .15) : 0);

/** Applies the league's validated rules to every supplied raw forecast. */
export function scoreLeagueForecasts(input: ScoreForecastsInput): ScoredForecasts {
  const { rules, signals, players } = input;
  if (!rules.actionable) throw new Error('Forecasts can only be scored by a validated complete live scoring snapshot.');
  const scoredAt = (input.scoredAt ?? new Date()).toISOString();
  const availability = input.availability ?? { policy: 'selected-week' as const };
  const statuses = availability.statuses ?? WAIVER_UNAVAILABLE_STATUSES;
  const absent = (status?: string | null) => statuses.includes((status ?? '').toLowerCase());
  const directory = new Map(players.map(player => [player.id, player]));
  const required = [...new Set(input.requiredWeeks ?? [])];
  const rejected: ForecastRejection[] = [];
  const scored: ScoredPlayer[] = [];
  const seen = new Set<string>();

  for (const sourceSignal of signals.players) {
    let signal = sourceSignal;
    const refuse = (kind: ForecastRejectionKind, message: string) => { rejected.push({ playerId: signal.playerId, kind, message }); return null; };
    const player = directory.get(signal.playerId);
    // 1. Player identity. An unverifiable subject makes its points meaningless, however well formed.
    if (seen.has(signal.playerId)) { refuse('identity', `${signal.playerId}: duplicate forecast; no projection can be treated as authoritative.`); continue; }
    seen.add(signal.playerId);
    if (!player) { refuse('identity', `${signal.playerId}: no synchronized Sleeper player has this ID, so the projection cannot be attributed.`); continue; }
    const positions = positionsOf(player);
    if (!positions.length) { refuse('identity', `${player.fullName || signal.playerId}: no fantasy position is known, so lineup eligibility cannot be validated.`); continue; }
    if (!player.fullName.trim()) { refuse('identity', `${signal.playerId}: the synchronized player record has no name.`); continue; }

    // Special-teams entity identity. `st_*` pays a rostered returner and `def_st_*` pays the D/ST
    // unit, at different rates for the same real event. One entity therefore never carries both
    // contracts, so a single return touchdown can never be scored twice inside one fantasy slot.
    const teamEntity = positions.includes('DEF');
    const individualForecasts = [...signal.weeks.flatMap(w => [w.specialTeams, w.floorSpecialTeams, w.ceilingSpecialTeams]), signal.dynastySpecialTeams];
    const teamForecasts = [...signal.weeks.flatMap(w => [w.defense, w.floorDefense, w.ceilingDefense]), signal.dynastyDefense];
    const individualRules = SPECIAL_TEAMS_CATEGORIES.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]).join(', ');
    const teamRules = SPECIAL_TEAMS_CATEGORIES.map(category => TEAM_SPECIAL_TEAMS_STATS[category]).join(', ');
    if (teamEntity && individualForecasts.some(Boolean)) {
      refuse('identity', `${player.fullName}: a team defense carries an individual special-teams forecast. This unit's return events belong in defense.specialTeams (${teamRules}); ${individualRules} pay a rostered returner on their own line, at different rates.`); continue;
    }
    if (!teamEntity && teamForecasts.some(Boolean)) {
      refuse('identity', `${player.fullName}: a rostered player carries a team defense forecast. Team special-teams events (${teamRules}) belong to the D/ST entity; this player's own return events are ${individualRules}.`); continue;
    }
    // The same attribution failure expressed as a raw key. It is an identity problem, not a unit
    // problem: the amount is well formed, and it is the entity being paid that is wrong.
    const statLines: Array<Record<string, number> | undefined> = [...signal.weeks.flatMap(w => [w.stats, w.floorStats, w.ceilingStats]), signal.dynastyStats];
    const lineKeys = new Set(statLines.flatMap(line => line ? Object.keys(line) : []));
    const misplaced = (teamEntity ? INDIVIDUAL_SPECIAL_TEAMS_KEYS : TEAM_SPECIAL_TEAMS_KEYS).filter(key => lineKeys.has(key));
    if (misplaced.length) {
      refuse('identity', teamEntity
        ? `${player.fullName}: a team defense stat line supplies ${misplaced.join(', ')}, the individual rules a rostered returner scores on their own line. This unit's return events are ${teamRules}.`
        : `${player.fullName}: a rostered player's stat line supplies ${misplaced.join(', ')}, which belongs to the D/ST entity. This player's own return events are ${individualRules}, and the two families pay different rates for the same real event.`);
      continue;
    }

    // Kicker adapters must provide complete distance/PAT counts for every scored scenario.
    // Normalize a copy: provider totals and distance aliases describe the same kicks.
    if (positions.includes('K')) {
      try {
        if (signal.role || signal.weeks.some(w => w.matchupMultiplier !== undefined && w.matchupMultiplier !== 1)) throw new Error('Kicker role/matchup multipliers are unsupported; supply contextual attempts/makes or kicker context.');
        signal = { ...signal, weeks: signal.weeks.map(w => {
          if ((w.floorKicker && !w.floorStats) || (w.ceilingKicker && !w.ceilingStats)) throw new Error('Kicker scenario metadata requires its raw stat line.');
          return { ...w, stats: normalizeKickerStats(rules, w.stats, w.kicker),
            floorStats: w.floorStats ? normalizeKickerStats(rules, w.floorStats, w.floorKicker) : undefined,
            ceilingStats: w.ceilingStats ? normalizeKickerStats(rules, w.ceilingStats, w.ceilingKicker) : undefined };
        }), dynastyStats: signal.dynastyStats ? normalizeKickerStats(rules, signal.dynastyStats, signal.dynastyKicker) : undefined };
        if (signal.dynastyKicker && !signal.dynastyStats) throw new Error('Dynasty kicker forecast requires dynastyStats.');
      } catch (error) {
        refuse('units', `${player.fullName}: ${error instanceof Error ? error.message : 'Invalid kicker forecast.'}`); continue;
      }
    }

    // Team defense adapters must provide every raw category and a complete tier distribution, so a
    // threshold bonus enters scoring at its probability instead of being granted on a good matchup.
    if (positions.includes('DEF')) {
      try {
        if (signal.role || signal.weeks.some(w => w.matchupMultiplier !== undefined && w.matchupMultiplier !== 1)) throw new Error('Team defense role/matchup multipliers are unsupported: scaling a total would move a probability-weighted threshold bonus linearly with the matchup. Supply opponent-specific counts, tier probabilities or defense context.');
        signal = { ...signal, weeks: signal.weeks.map(w => {
          if ((w.floorDefense && !w.floorStats) || (w.ceilingDefense && !w.ceilingStats)) throw new Error('Team defense scenario metadata requires its raw stat line.');
          return { ...w, stats: normalizeDefenseStats(rules, w.stats, w.defense),
            floorStats: w.floorStats ? normalizeDefenseStats(rules, w.floorStats, w.floorDefense) : undefined,
            ceilingStats: w.ceilingStats ? normalizeDefenseStats(rules, w.ceilingStats, w.ceilingDefense) : undefined };
        }), dynastyStats: signal.dynastyStats ? normalizeDefenseStats(rules, signal.dynastyStats, signal.dynastyDefense) : undefined };
        if (signal.dynastyDefense && !signal.dynastyStats) throw new Error('Dynasty team defense forecast requires dynastyStats.');
      } catch (error) {
        refuse('units', `${player.fullName}: ${error instanceof Error ? error.message : 'Invalid team defense forecast.'}`); continue;
      }
    }

    // A rostered player's own `st_*` counts, reconciled with the generic stat line. Team keys are
    // refused here, and a supplied count without its coverage declaration is refused rather than
    // left indistinguishable from a category the provider never modeled.
    if (!teamEntity) {
      try {
        signal = { ...signal, weeks: signal.weeks.map(w => {
          if ((w.floorSpecialTeams && !w.floorStats) || (w.ceilingSpecialTeams && !w.ceilingStats)) throw new Error('Individual special-teams scenario metadata requires its raw stat line.');
          return { ...w, stats: normalizeSpecialTeamsStats(rules, w.stats, w.specialTeams, `week ${w.week}`),
            floorStats: w.floorStats ? normalizeSpecialTeamsStats(rules, w.floorStats, w.floorSpecialTeams, `week ${w.week} floor`) : undefined,
            ceilingStats: w.ceilingStats ? normalizeSpecialTeamsStats(rules, w.ceilingStats, w.ceilingSpecialTeams, `week ${w.week} ceiling`) : undefined };
        }), dynastyStats: signal.dynastyStats ? normalizeSpecialTeamsStats(rules, signal.dynastyStats, signal.dynastySpecialTeams, 'the dynasty typical week') : undefined };
        if (signal.dynastySpecialTeams && !signal.dynastyStats) throw new Error('Dynasty individual special-teams forecast requires dynastyStats.');
      } catch (error) {
        refuse('units', `${player.fullName}: ${error instanceof Error ? error.message : 'Invalid individual special-teams forecast.'}`); continue;
      }
    }

    // 2. Raw-stat units. Every supplied key must be a statistic this league's own rules define.
    const lines: Array<[string, Record<string, number> | undefined]> = [
      ...signal.weeks.flatMap((week): Array<[string, Record<string, number> | undefined]> => [
        [`week ${week.week}`, week.stats], [`week ${week.week} floor`, week.floorStats], [`week ${week.week} ceiling`, week.ceilingStats],
      ]),
      ['the dynasty typical week', signal.dynastyStats],
    ];
    let invalid: string | null = null;
    let preScored = false;
    for (const [where, line] of lines) {
      if (!line || invalid) continue;
      for (const [stat, amount] of Object.entries(line)) {
        if (PRE_SCORED_KEYS.includes(stat.toLowerCase())) { invalid = `${player.fullName}: ${where} supplies "${stat}", a pre-scored fantasy total. Provide raw statistics; this league scores them.`; preScored = true; break; }
        if (!Number.isFinite(amount)) { invalid = `${player.fullName}: ${where} supplies a nonfinite "${stat}".`; break; }
        if (!rules.knows(stat)) { invalid = `${player.fullName}: ${where} supplies "${stat}", which this league's scoring rules do not define, so its unit cannot be validated.`; break; }
      }
    }
    if (invalid) { refuse(preScored ? 'pre-scored' : 'units', invalid); continue; }

    for (const forecast of signal.weeks) {
      for (const [split, stats] of [[forecast.rushingSplit, forecast.stats], [forecast.floorRushingSplit, forecast.floorStats], [forecast.ceilingRushingSplit, forecast.ceilingStats]] as const) {
        if (split !== undefined) invalid = validateRushingSplit(split, stats) ?? invalid;
      }
    }
    if (signal.dynastyRushingSplit !== undefined) invalid = validateRushingSplit(signal.dynastyRushingSplit, signal.dynastyStats) ?? invalid;
    if (invalid) { refuse('units', `${player.fullName}: ${invalid}`); continue; }

    // 3. Coverage the caller declared it needs. Missing weeks are refused rather than assumed empty.
    const missing = required.filter(week => !signal.weeks.some(forecast => forecast.week === week && typeof forecast.bye === 'boolean'));
    if (missing.length) { refuse('coverage', `${player.fullName}: week ${missing.join(', ')} forecasts with explicit bye flags are missing.`); continue; }

    // 4. Score every scenario with the same rule set, then apply and disclose post-scoring adjustments.
    const role = roleMultiplier(signal);
    const status = signal.injuryStatus ?? player.injuryStatus ?? player.status;
    const weeks: ScoredWeek[] = [];
    for (const forecast of [...signal.weeks].sort((a, b) => a.week - b.week)) {
      const week = scoreWeek(rules, signal, forecast, { role, status, absent, availability, quarterback: positions.includes('QB'), kicker: positions.includes('K'), defense: positions.includes('DEF') });
      // An inconsistent optional scenario is discarded and reported. It never silently widens a range,
      // and it never invalidates the mean, whose units and identity did validate.
      if (week.floor && week.floor.points > week.mean.points + 1e-9) {
        refuse('scenario', `${player.fullName}: the week ${forecast.week} floor stat line scores above its mean under this league's rules, so the floor is discarded. The mean projection is unaffected.`);
        week.floor = null; week.floorPoints = null;
      }
      if (week.ceiling && week.ceiling.points + 1e-9 < week.mean.points) {
        refuse('scenario', `${player.fullName}: the week ${forecast.week} ceiling stat line scores below its mean under this league's rules, so the ceiling is discarded. The mean projection is unaffected.`);
        week.ceiling = null; week.ceilingPoints = null;
      }
      weeks.push(week);
    }

    // 5. Receiving role, derived from the supplied workload and the points the league already
    //    produced. The one projection it may change is a supplied floor scenario, bounded.
    const analyzed = weeks.find(week => week.week === (availability.selectedWeek ?? weeks[0]?.week)) ?? weeks[0];
    const profile = analyzed && !positions.includes('QB') && !positions.includes('K') && !positions.includes('DEF') ? opportunityProfile({
      positions, signal, scored: analyzed.mean, weeks: weeks.map(week => week.opportunity).filter((v): v is WeekOpportunity => Boolean(v)),
      receptionPoints: rules.receptionPoints, scoringLabel: rules.label,
    }) : null;
    if (profile && profile.floorLift > 0) for (const week of weeks) applyFloorLift(week, profile.floorLift, profile.stability!);

    scored.push({
      playerId: signal.playerId, name: player.fullName, positions, team: player.team,
      injuryStatus: status ?? null, age: signal.age ?? null, weeks,
      dynasty: signal.dynastyStats
        ? positions.includes('DEF')
          ? scoreDefense(rules, signal.dynastyStats, signal.dynastyDefense!)
          : withSpecialTeams(rules, positions.includes('K') ? scoreKicker(rules, signal.dynastyStats, signal.dynastyKicker!) : positions.includes('QB') ? scoreQuarterback(rules, signal.dynastyStats, signal.dynastyRushingSplit) : rules.score(signal.dynastyStats), signal.dynastySpecialTeams)
        : null,
      opportunity: profile,
      scoringSnapshotId: rules.snapshotId, forecastUpdatedAt: signals.updatedAt,
      signal, player,
    });
  }
  return {
    scoringSnapshotId: rules.snapshotId, scoringLabel: rules.label, scoringSummary: scoringSummary(rules.configuration),
    forecastSource: signals.source, forecastUpdatedAt: signals.updatedAt, scoredAt,
    players: scored, rejected, byPlayerId: new Map(scored.map(value => [value.playerId, value])),
  };
}

function scoreWeek(
  rules: ScoringRules, signal: PlayerSignal, forecast: WeeklyForecast,
  context: { kicker: boolean; defense: boolean; quarterback: boolean; role: number; status?: string | null; absent(status?: string | null): boolean; availability: AvailabilityPolicy },
): ScoredWeek {
  // A `DEF` unit's return events are already inside `scoreDefense`, from the `def_st_*` rules. Every
  // other entity gets its own `st_*` attribution and coverage, including when nothing was modeled.
  const score = (stats: Record<string, number>, split?: WeeklyForecast['rushingSplit'], kicker?: WeeklyForecast['kicker'], defense?: WeeklyForecast['defense'], specialTeams?: WeeklyForecast['specialTeams']) =>
    context.defense ? scoreDefense(rules, stats, defense!)
      : withSpecialTeams(rules, context.kicker ? scoreKicker(rules, stats, kicker!) : context.quarterback ? scoreQuarterback(rules, stats, split) : rules.score(stats), specialTeams);
  const mean = score(forecast.stats, forecast.rushingSplit, forecast.kicker, forecast.defense, forecast.specialTeams);
  const floor = forecast.floorStats ? score(forecast.floorStats, forecast.floorRushingSplit, forecast.floorKicker, forecast.floorDefense, forecast.floorSpecialTeams) : null;
  const ceiling = forecast.ceilingStats ? score(forecast.ceilingStats, forecast.ceilingRushingSplit, forecast.ceilingKicker, forecast.ceilingDefense, forecast.ceilingSpecialTeams) : null;
  const bye = forecast.bye === true;
  const dated = signal.unavailableThroughWeek != null && forecast.week <= signal.unavailableThroughWeek;
  const designated = context.absent(context.status);
  const out = context.availability.policy === 'entire-horizon'
    ? (signal.unavailableThroughWeek != null ? dated : designated)
    : dated || (forecast.week === context.availability.selectedWeek && designated);
  const matchup = forecast.matchupMultiplier ?? 1;
  const adjustments: string[] = [];
  if (bye) adjustments.push(`Week ${forecast.week} is a bye, so the league-scored forecast is zeroed.`);
  else if (out) adjustments.push(dated ? `Unavailable through week ${signal.unavailableThroughWeek}, so the league-scored forecast is zeroed.` : `Availability "${context.status}" zeroes the league-scored forecast for week ${forecast.week}.`);
  else {
    if (matchup !== 1) adjustments.push(`Opponent adjustment ${matchup} applied after league scoring.`);
    if (context.role !== 1) adjustments.push(`Role trend adjustment ${Math.round((context.role - 1) * 1000) / 10}% applied after league scoring.`);
  }
  const multiplier = bye || out ? 0 : matchup * context.role;
  return {
    week: forecast.week, bye, opponent: forecast.opponent ?? null,
    mean, floor, ceiling, multiplier, adjustments,
    points: mean.points * multiplier,
    floorPoints: floor ? floor.points * multiplier : null,
    ceilingPoints: ceiling ? ceiling.points * multiplier : null,
    opportunity: weekOpportunity(forecast),
  };
}

/**
 * Narrows a supplied floor toward its own mean for a consistently targeted player. The mean and the
 * ceiling are never touched, a missing floor is never invented, and no points are added for a
 * reception — the floor scenario the provider already scored simply stops being treated as equally
 * likely for a player whose target volume barely moves. Recorded as a disclosed adjustment.
 */
function applyFloorLift(week: ScoredWeek, lift: number, stability: number): void {
  if (!week.floor || week.floorPoints == null || week.multiplier === 0) return;
  const lifted = week.floor.points + (week.mean.points - week.floor.points) * lift;
  const points = Math.round(lifted * 100) / 100;
  week.floor = {
    ...week.floor, points,
    explanation: `${week.floor.explanation}, lifted ${Math.round(lift * 100)}% toward the mean for a ${stability} target-stability score`,
    breakdown: `${week.floor.breakdown}; floor lifted ${Math.round(lift * 100)}% toward the mean on target stability ${stability} (mean and ceiling unchanged)`,
  };
  week.floorPoints = points * week.multiplier;
  week.adjustments.push(`Consistent targets (stability ${stability}) lift the supplied floor ${Math.round(lift * 100)}% toward the mean. The mean and ceiling are unchanged.`);
}

/** The league-scored value a lineup consumes for one week, with its explanation preserved. */
export function weekPoints(rules: ScoringRules, week: ScoredWeek): ScoredPoints {
  if (week.multiplier === 1) return week.mean;
  const points = Math.round(week.mean.points * week.multiplier * 100) / 100;
  const quarterback = week.mean.quarterback ? scaleQuarterback(week.mean.quarterback, week.multiplier) : undefined;
  return {
    points,
    quarterback,
    kicker: week.mean.kicker ? unavailableKicker(week.mean.kicker, week.adjustments.join(' ')) : undefined,
    defense: week.mean.defense ? unavailableDefense(week.mean.defense, week.adjustments.join(' ')) : undefined,
    // Coverage is a fact about the forecast, so it survives every post-scoring adjustment unchanged.
    specialTeams: week.mean.specialTeams ? scaleSpecialTeams(week.mean.specialTeams, week.multiplier, week.adjustments.join(' ')) : undefined,
    explanation: `${rules.describe(points)}${quarterback ? `. ${quarterback.explanation}` : ''}${week.adjustments.length ? ` (${week.adjustments.join(' ')})` : ''}`,
    breakdown: week.multiplier === 0 ? `${week.mean.breakdown} — zeroed: ${week.adjustments.join(' ')}` : `${week.mean.breakdown}; adjusted by ${Math.round(week.multiplier * 1000) / 1000}`,
    contributions: week.mean.contributions.map(value => ({ ...value, points: value.points * week.multiplier })),
  };
}
