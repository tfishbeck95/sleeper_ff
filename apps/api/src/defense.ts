import {
  POINTS_ALLOWED_BUCKETS as PTS, POINTS_ALLOWED_BOUNDS, YARDS_ALLOWED_BUCKETS as YDS, YARDS_ALLOWED_BOUNDS,
  type AllowedBreakdown, type AllowedDistribution, type DefenseBreakdown, type DefenseComponent, type DefenseForecast,
  type DefenseStreamerProfile, type OpponentQuarterbackStatus, type PointsAllowedBucket, type ScoredPoints,
  type ScoringRules, type YardsAllowedBucket,
  INDIVIDUAL_SPECIAL_TEAMS_KEYS, SPECIAL_TEAMS_CATEGORIES, TEAM_SPECIAL_TEAMS_STATS,
} from '@sleeper/domain';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const fraction = (v: unknown): v is number => count(v) && v <= 1;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
const round = (v: number) => Math.round(v * 100) / 100;
const percent = (v: number) => Math.round(v * 1000) / 10;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const clamp = (v: number, low = -1, high = 1) => Math.max(low, Math.min(high, v));
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Team defense forecast contains an unknown field; supply raw counts, tier probabilities and supported context only.');
}

/** The counts a D/ST forecast must carry, with the Sleeper key each one maps to and a sanity ceiling. */
const COUNTS = [
  ['sacks', 'sack', 'Sacks', 15],
  ['interceptions', 'int', 'Interceptions', 8],
  ['forcedFumbles', 'ff', 'Forced fumbles', 8],
  ['fumbleRecoveries', 'fum_rec', 'Fumble recoveries', 8],
  ['safeties', 'safe', 'Safeties', 3],
  ['blockedKicks', 'blk_kick', 'Blocked kicks', 4],
  ['defensiveTouchdowns', 'def_td', 'Defensive touchdowns', 5],
] as const;
/**
 * The unit's own special-teams rules. `def_st_*` is the team; `st_*` belongs to a rostered player.
 *
 * The Sleeper key of each category comes from the shared map both families are defined in, so the
 * team contract and the individual contract cannot drift into scoring the same rule.
 */
const TEAM_SPECIAL_TEAMS = [
  ['touchdowns', TEAM_SPECIAL_TEAMS_STATS.touchdowns, 'Special-teams touchdowns', 5],
  ['forcedFumbles', TEAM_SPECIAL_TEAMS_STATS.forcedFumbles, 'Special-teams forced fumbles', 5],
  ['fumbleRecoveries', TEAM_SPECIAL_TEAMS_STATS.fumbleRecoveries, 'Special-teams fumble recoveries', 5],
] as const;

/** The team rules named in refusals, kept in one place so the two contracts cannot drift apart. */
const teamRuleList = SPECIAL_TEAMS_CATEGORIES.map(category => TEAM_SPECIAL_TEAMS_STATS[category])
  .reduce((text, stat, index, all) => index === 0 ? stat : `${text}${index === all.length - 1 ? ' and ' : ', '}${stat}`, '');

const ptsKey = (bucket: PointsAllowedBucket) => `pts_allow_${bucket}`;
const ydsKey = (bucket: YardsAllowedBucket) => `yds_allow_${bucket}`;

/** A tier distribution is complete, normalized, and consistent with any mean the provider supplied. */
function distribution(value: unknown, buckets: readonly string[], bounds: Readonly<Record<string, readonly [number, number]>>, what: string): void {
  if (!object(value) || !object(value.buckets)) throw new Error(`Team defense ${what} requires a probability for every Sleeper tier.`);
  keys(value, ['buckets', 'expected']);
  const table = value.buckets;
  keys(table, buckets);
  for (const bucket of buckets) {
    if (!fraction(table[bucket])) throw new Error(`Team defense ${what} tier ${bucket} must be a probability from 0 to 1; every tier is explicit, including zero.`);
  }
  const probability = (bucket: string) => table[bucket] as number;
  const total = sum(buckets.map(probability));
  if (!close(total, 1)) throw new Error(`Team defense ${what} probabilities must describe one game and sum to 1; received ${total}.`);
  if (value.expected !== undefined) {
    if (!count(value.expected)) throw new Error(`Team defense expected ${what} must be a finite nonnegative mean.`);
    // A mean must be reachable from the distribution that produced it, so an optimistic tier set
    // cannot be paired with a pessimistic mean, or the reverse.
    const low = sum(buckets.map(bucket => probability(bucket) * bounds[bucket][0]));
    const open = probability(buckets[buckets.length - 1]) > 0;
    const high = open ? Infinity : sum(buckets.map(bucket => probability(bucket) * bounds[bucket][1]));
    if (value.expected < low - 1e-6 || value.expected > high + 1e-6) throw new Error(`Team defense expected ${what} (${value.expected}) is impossible under its own tier probabilities, which allow ${round(low)}${open ? ' or more' : ` to ${round(high)}`}.`);
  }
}

/** Runs at both the file adapter and the scoring boundary, including direct in-process callers. */
export function validateDefenseForecast(value: unknown): asserts value is DefenseForecast {
  if (!object(value)) throw new Error('Team defense forecast requires sacks, interceptions, forced fumbles, fumble recoveries, safeties, blocked kicks, defensive touchdowns and complete points/yards-allowed tier probabilities.');
  keys(value, [...COUNTS.map(c => c[0]), 'pointsAllowed', 'yardsAllowed', 'specialTeams', 'context']);
  for (const [field, , label, ceiling] of COUNTS) {
    if (!count(value[field]) || (value[field] as number) > ceiling) throw new Error(`${label} must be a finite nonnegative expected count for one game, at most ${ceiling}.`);
  }
  distribution(value.pointsAllowed, PTS, POINTS_ALLOWED_BOUNDS, 'points allowed');
  distribution(value.yardsAllowed, YDS, YARDS_ALLOWED_BOUNDS, 'yards allowed');
  if (value.specialTeams !== undefined) {
    if (!object(value.specialTeams)) throw new Error('Team special-teams events require touchdowns, forced fumbles and fumble recoveries.');
    keys(value.specialTeams, TEAM_SPECIAL_TEAMS.map(t => t[0]));
    for (const [field, , label, ceiling] of TEAM_SPECIAL_TEAMS) {
      if (!count(value.specialTeams[field]) || (value.specialTeams[field] as number) > ceiling) throw new Error(`${label} must be a finite nonnegative expected count, at most ${ceiling}.`);
    }
  }
  if (value.context !== undefined) validateContext(value.context);
}

function validateContext(value: unknown): void {
  if (!object(value) || typeof value.includedInForecast !== 'boolean') throw new Error('Team defense context must declare whether it is included in the raw forecast.');
  keys(value, ['includedInForecast', 'opponentPressure', 'opponentTurnovers', 'opponentOffensiveLine', 'opponentQuarterback', 'game', 'specialTeams']);
  if (value.opponentPressure !== undefined) {
    if (!object(value.opponentPressure) || !fraction(value.opponentPressure.sackRateAllowed) || !fraction(value.opponentPressure.pressureRateAllowed)) throw new Error('Opponent pressure context requires sack and pressure rates allowed as fractions of dropbacks.');
    keys(value.opponentPressure, ['sackRateAllowed', 'pressureRateAllowed']);
  }
  if (value.opponentTurnovers !== undefined) {
    if (!object(value.opponentTurnovers) || !fraction(value.opponentTurnovers.interceptionRate) || !fraction(value.opponentTurnovers.fumbleRate)) throw new Error('Opponent turnover context requires interception and fumble rates as fractions.');
    keys(value.opponentTurnovers, ['interceptionRate', 'fumbleRate']);
  }
  if (value.opponentOffensiveLine !== undefined) {
    if (!object(value.opponentOffensiveLine) || !count(value.opponentOffensiveLine.startersOut) || (value.opponentOffensiveLine.startersOut as number) > 5
      || (value.opponentOffensiveLine.continuity !== undefined && !fraction(value.opponentOffensiveLine.continuity))) throw new Error('Opponent offensive-line context requires 0 to 5 starters out and an optional 0-1 continuity score.');
    keys(value.opponentOffensiveLine, ['startersOut', 'continuity']);
  }
  if (value.opponentQuarterback !== undefined) {
    const statuses: OpponentQuarterbackStatus[] = ['confirmed-starter', 'questionable', 'backup', 'rookie-starter', 'unknown'];
    if (!object(value.opponentQuarterback) || !statuses.includes(value.opponentQuarterback.status as OpponentQuarterbackStatus)
      || (value.opponentQuarterback.name !== undefined && (typeof value.opponentQuarterback.name !== 'string' || !value.opponentQuarterback.name.trim()))) throw new Error(`Opponent quarterback status must be one of ${statuses.join(', ')}.`);
    keys(value.opponentQuarterback, ['status', 'name']);
  }
  if (value.game !== undefined) {
    if (!object(value.game) || value.game.licensed !== true || typeof value.game.source !== 'string' || !value.game.source.trim()
      || !count(value.game.impliedOpponentPoints) || (value.game.impliedOpponentPoints as number) > 100
      || typeof value.game.spread !== 'number' || !Number.isFinite(value.game.spread) || Math.abs(value.game.spread) > 100) throw new Error('Team defense game environment requires a named licensed source, implied opponent points and a team-perspective spread.');
    keys(value.game, ['source', 'licensed', 'impliedOpponentPoints', 'spread']);
  }
  if (value.specialTeams !== undefined) {
    if (!object(value.specialTeams) || !count(value.specialTeams.returnOpportunities) || (value.specialTeams.returnOpportunities as number) > 20
      || !count(value.specialTeams.opponentReturnYardsAllowed) || (value.specialTeams.opponentReturnYardsAllowed as number) > 100
      || (value.specialTeams.opponentMuffRate !== undefined && !fraction(value.specialTeams.opponentMuffRate))) throw new Error('Special-teams context requires expected return opportunities, opponent return yards allowed per return and an optional 0-1 muff rate.');
    keys(value.specialTeams, ['returnOpportunities', 'opponentReturnYardsAllowed', 'opponentMuffRate']);
  }
}

/**
 * Canonical Sleeper counts.
 *
 * Each tier's amount is its probability, so the league's own rate prices the bonus at the chance of
 * earning it. `ff` and `fum_rec` are written independently: a fumble the defense forces *and*
 * recovers is two Sleeper events, and neither count is ever derived from the other.
 */
export function defenseStats(forecast: DefenseForecast): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [field, stat] of COUNTS) result[stat] = forecast[field];
  for (const bucket of PTS) result[ptsKey(bucket)] = forecast.pointsAllowed.buckets[bucket];
  for (const bucket of YDS) result[ydsKey(bucket)] = forecast.yardsAllowed.buckets[bucket];
  if (forecast.specialTeams) for (const [field, stat] of TEAM_SPECIAL_TEAMS) result[stat] = forecast.specialTeams[field];
  if (forecast.pointsAllowed.expected !== undefined) result.pts_allow = forecast.pointsAllowed.expected;
  if (forecast.yardsAllowed.expected !== undefined) result.yds_allow = forecast.yardsAllowed.expected;
  return result;
}

export function normalizeDefenseStats(rules: ScoringRules, stats: Record<string, number>, forecast: unknown): Record<string, number> {
  validateDefenseForecast(forecast);
  const canonical = defenseStats(forecast);
  const normalized = { ...stats };
  for (const [key, amount] of Object.entries(stats)) if (/^(sack|int|ff|fum_rec|safe|blk_kick|def_td|def_st_|pts_allow|yds_allow)/.test(key) && !count(amount)) throw new Error(`Team defense ${key} must be a finite nonnegative expected count or probability.`);
  for (const key of INDIVIDUAL_SPECIAL_TEAMS_KEYS) {
    if (Object.hasOwn(stats, key)) throw new Error(`Team defense stats supply "${key}", the individual special-teams rule a rostered returner scores on their own line. The unit's return events belong in specialTeams, which maps to ${teamRuleList}.`);
  }
  for (const [key, amount] of Object.entries(canonical)) {
    if (Object.hasOwn(stats, key) && (!Number.isFinite(stats[key]) || !close(stats[key], amount))) throw new Error(`Team defense ${key} conflicts with its forecast; overlapping counts must agree.`);
    // Inactive/absent scoring keys are not forced into the generic raw-stat boundary.
    delete normalized[key];
    if (rules.knows(key)) normalized[key] = amount;
  }
  for (const [key, what] of [['pts_allow', 'points'], ['yds_allow', 'yards']] as const) {
    if (rules.configuration.settings?.[key] && canonical[key] === undefined) throw new Error(`Team defense ${key} is active in live scoring and requires the expected ${what} allowed; a tier midpoint is not assumed.`);
  }
  for (const [, stat, label] of TEAM_SPECIAL_TEAMS) {
    if (rules.configuration.settings?.[stat] && !(forecast as DefenseForecast).specialTeams) throw new Error(`${label} (${stat}) is active in live scoring, so the forecast must supply team special-teams events rather than leaving them at an assumed zero.`);
  }
  return normalized;
}

/** Attribution from the shared league score, never a second scoring pass. */
export function scoreDefense(rules: ScoringRules, stats: Record<string, number>, forecast: DefenseForecast): ScoredPoints {
  const scored = rules.score(stats);
  const rate = (key: string) => rules.configuration.settings?.[key] ?? 0;
  const contribution = (predicate: (key: string) => boolean) => sum(scored.contributions.filter(c => predicate(c.stat)).map(c => c.points));
  const component = (label: string, stat: string, amount: number): DefenseComponent => ({ label, stat, amount, rate: rate(stat), points: amount * rate(stat) });
  const components = [
    ...COUNTS.map(([field, stat, label]) => component(label, stat, forecast[field])),
    ...(forecast.specialTeams ? TEAM_SPECIAL_TEAMS.map(([field, stat, label]) => component(label, stat, forecast.specialTeams![field])) : []),
    ...(forecast.pointsAllowed.expected === undefined ? [] : [component('Points allowed, per point', 'pts_allow', forecast.pointsAllowed.expected)]),
    ...(forecast.yardsAllowed.expected === undefined ? [] : [component('Yards allowed, per yard', 'yds_allow', forecast.yardsAllowed.expected)]),
  ];
  const pointsAllowed = allowed(forecast.pointsAllowed, PTS, ptsKey, rate, 'points allowed', 'a shutout');
  const yardsAllowed = allowed(forecast.yardsAllowed, YDS, ydsKey, rate, 'yards allowed', 'under 100 yards');
  const shutoutProbability = forecast.pointsAllowed.buckets['0'];
  const under100Probability = forecast.yardsAllowed.buckets['0_100'];
  // Exhaustive and disjoint, so the subtotals below always sum back to the league's own total.
  const GROUPS = {
    pressurePoints: (k: string) => k === 'sack',
    turnoverPoints: (k: string) => ['int', 'ff', 'fum_rec'].includes(k),
    touchdownPoints: (k: string) => k === 'def_td',
    situationalPoints: (k: string) => ['safe', 'blk_kick'].includes(k),
    specialTeamsPoints: (k: string) => k.startsWith('def_st_'),
    thresholdPoints: (k: string) => k.startsWith('pts_allow') || k.startsWith('yds_allow'),
  };
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([name, predicate]) => [name, contribution(predicate)])) as Record<keyof typeof GROUPS, number>;
  // One driver per threshold family, so an active per-point or per-yard rule — often the largest
  // single component — is explained beside the tier bonuses rather than dropped from the summary.
  const thresholdDriver = (label: string, breakdown: AllowedBreakdown<string>, stat: string) => {
    const continuous = components.find(c => c.stat === stat && c.points !== 0);
    const points = breakdown.expectedPoints + (continuous?.points ?? 0);
    return points === 0 ? [] : [{ label, points, explanation: `${breakdown.explanation}${continuous ? ` The per-unit ${stat} rule adds ${round(continuous.amount)} × ${continuous.rate} = ${round(continuous.points)} points.` : ''}` }];
  };
  const drivers = [
    ...components.filter(c => c.points !== 0 && !c.stat.startsWith('pts_allow') && !c.stat.startsWith('yds_allow'))
      .map(c => ({ label: c.label, points: c.points, explanation: `${round(c.amount)} × ${c.rate} = ${round(c.points)} points.` })),
    ...thresholdDriver('Points allowed', pointsAllowed, 'pts_allow'),
    ...thresholdDriver('Yards allowed', yardsAllowed, 'yds_allow'),
  ].sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.label.localeCompare(b.label));
  const defense: DefenseBreakdown = {
    components,
    pointsAllowed: { ...pointsAllowed, shutoutProbability },
    yardsAllowed: { ...yardsAllowed, under100Probability },
    ...groups,
    otherPoints: contribution(k => !Object.values(GROUPS).some(predicate => predicate(k))),
    expectedPoints: scored.points, drivers, context: forecast.context ?? null,
    explanation: `${round(scored.points)} expected points`
      + (drivers.length ? `; largest drivers ${drivers.slice(0, 3).map(d => `${d.label} ${round(d.points) >= 0 ? '+' : ''}${round(d.points)}`).join(', ')}` : '; no supplied category has a non-zero rule in this league')
      + `. Turnovers contribute ${round(groups.turnoverPoints)} points across separate forced-fumble, recovery and interception rules, and pressure ${round(groups.pressurePoints)}. `
      + `Threshold bonuses are weighted by probability, never granted: ${pointsAllowed.explanation} ${yardsAllowed.explanation}`,
  };
  return { ...scored, defense, explanation: `${scored.explanation}. ${defense.explanation}` };
}

/** Each tier contributes `probability × rate`, so a favorable matchup raises value without paying a bonus. */
function allowed<Bucket extends string>(
  value: AllowedDistribution<Bucket>, buckets: readonly Bucket[], key: (bucket: Bucket) => string,
  rate: (stat: string) => number, what: string, best: string,
): AllowedBreakdown<Bucket> {
  const tiers = buckets.map(bucket => ({ bucket, stat: key(bucket), probability: value.buckets[bucket], rate: rate(key(bucket)), points: value.buckets[bucket] * rate(key(bucket)) }));
  const expectedPoints = sum(tiers.map(tier => tier.points));
  const top = tiers.find(tier => tier.bucket === buckets[0])!;
  return {
    tiers, expected: value.expected ?? null, expectedPoints,
    explanation: top.rate === 0
      ? `This league scores no ${what} tier that the forecast reaches, so ${what} contributes ${round(expectedPoints)} points.`
      : `${percent(top.probability)}% chance of ${best} earns ${round(top.points)} of the ${top.rate}-point bonus; all ${what} tiers together are worth ${round(expectedPoints)} points${value.expected == null ? '' : ` against a ${round(value.expected)} mean`}.`,
  };
}

/**
 * Explainable, bounded streamer preferences; expected fantasy points remain the live league score.
 *
 * Shutout and yardage preferences are deliberately separate from the probability-weighted bonuses
 * already inside those points: they express a preference for that upside shape, not a second payment.
 */
export function defenseStreamerProfile(d: DefenseBreakdown): DefenseStreamerProfile {
  const factors: DefenseStreamerProfile['factors'] = [];
  const add = (label: string, value: number, explanation: string) => factors.push({ label, value: round(value), explanation });
  const c = d.context;
  const missingContext: string[] = [];
  const contextFactor = (label: string, value: number, explanation: string) => add(label, c?.includedInForecast ? 0 : value, explanation + (c?.includedInForecast ? ' Already included in the forecast counts and tier probabilities; no extra preference.' : ' Context preference only; projected points unchanged.'));
  add('Shutout probability', .3 * d.pointsAllowed.shutoutProbability, `${percent(d.pointsAllowed.shutoutProbability)}% chance of a shutout, already worth ${round(d.pointsAllowed.tiers[0].points)} points at its probability; this preference is capped at 0.3 and is not a second bonus.`);
  add('Under 100 yards allowed', .2 * d.yardsAllowed.under100Probability, `${percent(d.yardsAllowed.under100Probability)}% chance of holding the opponent under 100 total yards, already worth ${round(d.yardsAllowed.tiers[0].points)} points at its probability; this preference is capped at 0.2.`);
  if (c?.opponentPressure) contextFactor('Opponent pressure and sack exposure', .35 * clamp(((c.opponentPressure.sackRateAllowed - .065) / .035 + (c.opponentPressure.pressureRateAllowed - .22) / .1) / 2), `Opponent allows a ${percent(c.opponentPressure.sackRateAllowed)}% sack rate and ${percent(c.opponentPressure.pressureRateAllowed)}% pressure rate.`);
  else missingContext.push('Opponent pressure and sack exposure unavailable; no pass-rush advantage assumed.');
  if (c?.opponentTurnovers) contextFactor('Opponent interception and fumble rates', .3 * clamp(((c.opponentTurnovers.interceptionRate - .024) / .016 + (c.opponentTurnovers.fumbleRate - .013) / .009) / 2), `Opponent gives the ball away at a ${percent(c.opponentTurnovers.interceptionRate)}% interception rate and ${percent(c.opponentTurnovers.fumbleRate)}% fumble rate.`);
  else missingContext.push('Opponent interception and fumble rates unavailable; no takeaway advantage assumed.');
  if (c?.opponentOffensiveLine) {
    const line = c.opponentOffensiveLine;
    contextFactor('Opponent offensive-line health', .3 * clamp(line.startersOut / 2.5) + (line.continuity == null ? 0 : .1 * clamp((.85 - line.continuity) / .3)), `${line.startersOut} of five opposing line starters are out${line.continuity == null ? ', with no continuity score supplied' : `, with ${line.continuity} line continuity`}.`);
  } else missingContext.push('Opponent offensive-line health unavailable; a fully healthy line is not assumed either way.');
  const QUARTERBACK: Record<OpponentQuarterbackStatus, number> = { 'confirmed-starter': 0, questionable: .1, backup: .3, 'rookie-starter': .2, unknown: 0 };
  if (c?.opponentQuarterback && c.opponentQuarterback.status !== 'unknown') {
    const qb = c.opponentQuarterback;
    contextFactor('Opponent starting quarterback', QUARTERBACK[qb.status], `Opponent quarterback${qb.name ? ` ${qb.name}` : ''} is designated ${qb.status.replace('-', ' ')}.`);
  } else missingContext.push('Opponent starting quarterback is unconfirmed; no backup-quarterback advantage assumed.');
  if (c?.game) {
    contextFactor('Opponent implied scoring', .25 * clamp((21 - c.game.impliedOpponentPoints) / 8), `${c.game.source} (licensed): ${c.game.impliedOpponentPoints} implied opponent points.`);
    contextFactor('Expected game script', -.2 * clamp(c.game.spread / 14), `${c.game.source}: team spread ${c.game.spread}; a favored defense plays more opponent dropbacks, which is where sacks and interceptions come from.`);
  } else missingContext.push('Licensed game script and implied opponent scoring unavailable; no market input used.');
  if (c?.specialTeams) {
    const st = c.specialTeams;
    contextFactor('Special-teams opportunity and opponent weakness', .3 * clamp(.5 * clamp((st.returnOpportunities - 4) / 3) + .5 * clamp((st.opponentReturnYardsAllowed - 9) / 5 + (st.opponentMuffRate ?? 0) / .05)), `${round(st.returnOpportunities)} expected returns against an opponent allowing ${round(st.opponentReturnYardsAllowed)} yards per return${st.opponentMuffRate == null ? '' : ` and muffing ${percent(st.opponentMuffRate)}% of them`}.`);
  } else missingContext.push('Special-teams opportunity and opponent kicking weakness unavailable; no return advantage assumed.');
  return { forecast: d, rankingAdjustment: round(sum(factors.map(f => f.value))), factors, missingContext };
}

/** D/ST forecasts have no generic role/matchup multiplier; only availability can zero them. */
export function unavailableDefense(value: DefenseBreakdown, note: string): DefenseBreakdown {
  const zero = <Bucket extends string>(a: AllowedBreakdown<Bucket>) => ({ ...a, expectedPoints: 0, tiers: a.tiers.map(t => ({ ...t, points: 0 })), explanation: `${a.explanation} Zeroed after availability.` });
  return { ...value,
    components: value.components.map(c => ({ ...c, points: 0 })),
    pointsAllowed: { ...zero(value.pointsAllowed), shutoutProbability: value.pointsAllowed.shutoutProbability },
    yardsAllowed: { ...zero(value.yardsAllowed), under100Probability: value.yardsAllowed.under100Probability },
    pressurePoints: 0, turnoverPoints: 0, touchdownPoints: 0, situationalPoints: 0, specialTeamsPoints: 0, thresholdPoints: 0, otherPoints: 0,
    expectedPoints: 0, drivers: value.drivers.map(d => ({ ...d, points: 0, explanation: `Before availability: ${d.explanation}` })),
    availabilityNote: `${note} Counts and tier probabilities below describe the provider forecast before availability.`,
    explanation: `0 expected points after availability. ${note}`,
  };
}
