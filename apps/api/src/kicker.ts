import { KICKER_DISTANCE_BANDS as BANDS, type KickerForecast, type KickerBreakdown, type KickerStreamerProfile, type ScoredPoints, type ScoringRules } from '@sleeper/domain';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const fraction = (v: unknown): v is number => count(v) && v <= 1;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
const round = (v: number) => Math.round(v * 100) / 100;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const clamp = (v: number, low = -1, high = 1) => Math.max(low, Math.min(high, v));
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Kicker forecast contains an unknown field; supply raw counts and supported context only.');
}

/** Runs at both the file adapter and the scoring boundary, including direct in-process callers. */
export function validateKickerForecast(value: unknown): asserts value is KickerForecast {
  if (!object(value)) throw new Error('Kicker forecast requires attempts and makes in all six distance categories, PATs and miss semantics.');
  keys(value, ['fieldGoals', 'pat', 'misses', 'longAttemptProbability', 'context']);
  if (!object(value.fieldGoals)) throw new Error('Kicker field-goal distance categories are required.');
  keys(value.fieldGoals, BANDS);
  for (const band of BANDS) {
    const row = value.fieldGoals[band];
    if (!object(row) || !count(row.attempts) || !count(row.makes) || row.makes > row.attempts) throw new Error(`Kicker ${band} requires nonnegative attempts and makes no greater than attempts.`);
    keys(row, ['attempts', 'makes']);
  }
  if (!object(value.pat) || !count(value.pat.makes) || !count(value.pat.misses)) throw new Error('Kicker PAT makes and misses are required.');
  keys(value.pat, ['makes', 'misses']);
  if (!object(value.misses) || value.misses.semantics !== 'all-attempts-including-blocks') throw new Error('Kicker misses must use all-attempts-including-blocks semantics, matching Sleeper fgmiss.');
  keys(value.misses, ['semantics', 'total', 'byDistance']);
  const fg = value.fieldGoals as unknown as KickerForecast['fieldGoals'];
  const totalMisses = sum(BANDS.map(b => fg[b].attempts - fg[b].makes));
  if (value.misses.total === undefined && value.misses.byDistance === undefined) throw new Error('Kicker misses require a total or complete distance breakdown.');
  if (value.misses.total !== undefined && (!count(value.misses.total) || !close(value.misses.total, totalMisses))) throw new Error('Kicker total misses must equal attempts minus makes across all distances.');
  if (value.misses.byDistance !== undefined) {
    if (!object(value.misses.byDistance)) throw new Error('Invalid kicker distance misses.');
    keys(value.misses.byDistance, BANDS);
    for (const band of BANDS) if (!count(value.misses.byDistance[band]) || !close(value.misses.byDistance[band] as number, fg[band].attempts - fg[band].makes)) throw new Error(`Kicker ${band} misses disagree with attempts minus makes.`);
  }
  const longAttempts = fg['50_59'].attempts + fg['60p'].attempts;
  if (!fraction(value.longAttemptProbability) || value.longAttemptProbability > longAttempts + 1e-6 || (longAttempts > 0 && value.longAttemptProbability === 0)) throw new Error('Kicker long-attempt probability must describe at least one 50+ attempt and agree with expected attempts.');
  if (value.context !== undefined) {
    const c = value.context;
    if (!object(c) || typeof c.includedInForecast !== 'boolean') throw new Error('Kicker context must declare whether it is included in the raw forecast.');
    keys(c, ['includedInForecast', 'offense', 'opponent', 'stadium', 'weather', 'game']);
    if (c.offense !== undefined) {
      if (!object(c.offense) || !count(c.offense.drivesPerGame) || c.offense.drivesPerGame > 30 || !fraction(c.offense.scoringDriveRate)) throw new Error('Invalid kicker offensive drive quality.');
      keys(c.offense, ['drivesPerGame', 'scoringDriveRate']);
    }
    if (c.opponent !== undefined) {
      if (!object(c.opponent) || !fraction(c.opponent.redZoneTouchdownRate)) throw new Error('Invalid kicker opponent red-zone tendency.');
      keys(c.opponent, ['redZoneTouchdownRate']);
    }
    if (c.stadium !== undefined) {
      if (!object(c.stadium) || typeof c.stadium.name !== 'string' || !c.stadium.name.trim() || !['indoor', 'outdoor', 'retractable-open', 'retractable-closed'].includes(String(c.stadium.roof))) throw new Error('Invalid kicker stadium context.');
      keys(c.stadium, ['name', 'roof']);
    }
    if (c.weather !== undefined) {
      if (!object(c.weather) || !count(c.weather.windMph) || c.weather.windMph > 200 || !fraction(c.weather.precipitationProbability) || typeof c.weather.temperatureF !== 'number' || !Number.isFinite(c.weather.temperatureF) || c.weather.temperatureF < -100 || c.weather.temperatureF > 150) throw new Error('Invalid kicker weather context.');
      keys(c.weather, ['windMph', 'precipitationProbability', 'temperatureF']);
    }
    if (c.game !== undefined) {
      if (!object(c.game) || c.game.licensed !== true || typeof c.game.source !== 'string' || !c.game.source.trim() || !count(c.game.impliedTeamPoints) || c.game.impliedTeamPoints > 100 || typeof c.game.spread !== 'number' || !Number.isFinite(c.game.spread) || Math.abs(c.game.spread) > 100) throw new Error('Kicker game environment requires a named licensed source, implied team points and a team-perspective spread.');
      keys(c.game, ['source', 'licensed', 'impliedTeamPoints', 'spread']);
    }
  }
}

/** Canonical Sleeper counts. Aggregate misses are NEVER total + distance misses. */
export function kickerStats(forecast: KickerForecast): Record<string, number> {
  const result: Record<string, number> = { xpm: forecast.pat.makes, xpmiss: forecast.pat.misses };
  for (const b of BANDS) {
    result[`fgm_${b}`] = forecast.fieldGoals[b].makes;
    result[`fgmiss_${b}`] = forecast.fieldGoals[b].attempts - forecast.fieldGoals[b].makes;
  }
  result.fgm = sum(BANDS.map(b => result[`fgm_${b}`]));
  result.fgmiss = sum(BANDS.map(b => result[`fgmiss_${b}`]));
  result.fgm_50p = result.fgm_50_59 + result.fgm_60p;
  result.fgmiss_50p = result.fgmiss_50_59 + result.fgmiss_60p;
  return result;
}

export function normalizeKickerStats(rules: ScoringRules, stats: Record<string, number>, forecast: unknown): Record<string, number> {
  validateKickerForecast(forecast);
  const canonical = kickerStats(forecast);
  const normalized = { ...stats };
  for (const [key, amount] of Object.entries(stats)) if (/^(fgm|fgmiss|xpm)/.test(key) && !count(amount)) throw new Error(`Kicker ${key} must be a finite nonnegative expected count or yardage.`);
  for (const [key, amount] of Object.entries(canonical)) {
    if (Object.hasOwn(stats, key) && (!Number.isFinite(stats[key]) || !close(stats[key], amount))) throw new Error(`Kicker ${key} conflicts with its distance/PAT forecast; overlapping counts must agree.`);
    // Inactive/absent scoring keys are not forced into the generic raw-stat boundary.
    delete normalized[key];
    if (rules.knows(key)) normalized[key] = amount;
  }
  for (const key of ['fgm_yds', 'fgm_yds_over_30']) {
    if (rules.configuration.settings?.[key] && !count(stats[key])) throw new Error(`Kicker ${key} is active in live scoring and requires projected made-kick yardage; distance midpoints are not assumed.`);
  }
  return normalized;
}

/** Attribution from the shared league score, never a second scoring pass. */
export function scoreKicker(rules: ScoringRules, stats: Record<string, number>, forecast: KickerForecast): ScoredPoints {
  const scored = rules.score(stats);
  const contribution = (predicate: (key: string) => boolean) => sum(scored.contributions.filter(c => predicate(c.stat)).map(c => c.points));
  const rate = (key: string) => rules.configuration.settings?.[key] ?? 0;
  const distances = BANDS.map(b => {
    const { attempts, makes } = forecast.fieldGoals[b];
    const misses = attempts - makes;
    const long = b === '50_59' || b === '60p';
    return { band: b, attempts, makes, misses,
      makePoints: makes * (rate('fgm') + rate(`fgm_${b}`) + (long ? rate('fgm_50p') : 0)),
      missPoints: misses * (rate('fgmiss') + rate(`fgmiss_${b}`) + (long ? rate('fgmiss_50p') : 0)),
    };
  });
  const attempts = sum(distances.map(b => b.attempts));
  const makes = sum(distances.map(b => b.makes));
  const fieldGoalMissPoints = contribution(k => k === 'fgmiss' || k.startsWith('fgmiss_'));
  const patMissPoints = contribution(k => k === 'xpmiss');
  const missDownside = Math.max(0, -sum(scored.contributions.filter(c => (c.stat === 'xpmiss' || c.stat === 'fgmiss' || c.stat.startsWith('fgmiss_')) && c.points < 0).map(c => c.points)));
  const kicker: KickerBreakdown = {
    distances, expectedAttempts: attempts, expectedMakes: makes, expectedMisses: attempts - makes,
    longAttemptProbability: forecast.longAttemptProbability, accuracy: attempts ? makes / attempts : null,
    patMakes: forecast.pat.makes, patMisses: forecast.pat.misses, patPoints: contribution(k => k === 'xpm' || k === 'xpmiss'),
    fieldGoalMissPoints, patMissPoints, missDownside, expectedPoints: scored.points, context: forecast.context ?? null,
    explanation: `${round(scored.points)} expected points; ${round(attempts)} FG attempts, ${round(makes)} expected makes, ${round(forecast.longAttemptProbability * 100)}% probability of a 50+ yard attempt. Miss downside: ${round(missDownside)} points already deducted (${round(fieldGoalMissPoints)} FG, ${round(patMissPoints)} PAT). This is an expected deduction, not a worst-case floor.`,
  };
  return { ...scored, kicker, explanation: `${scored.explanation}. ${kicker.explanation}` };
}

/** Explainable, bounded streamer preferences; expected fantasy points remain the live league score. */
export function kickerStreamerProfile(k: KickerBreakdown): KickerStreamerProfile {
  const factors: KickerStreamerProfile['factors'] = [];
  const add = (label: string, value: number, explanation: string) => factors.push({ label, value: round(value), explanation });
  add('Expected attempts', .3 * clamp((k.expectedAttempts - 2) / 2), `${round(k.expectedAttempts)} expected FG attempts; preference capped at ±0.3.`);
  add('Long-distance probability', .3 * k.longAttemptProbability, `${round(k.longAttemptProbability * 100)}% chance of at least one 50+ yard attempt; preference up to 0.3.`);
  add('Accuracy', k.accuracy === null ? 0 : .2 * clamp((k.accuracy - .8) / .2), k.accuracy === null ? 'No attempts; accuracy unknown.' : `${round(k.accuracy * 100)}% expected accuracy; preference capped at ±0.2.`);
  add('Miss downside', -Math.min(2, .5 * k.missDownside), `${round(k.missDownside)} expected miss deductions are already in points; a separate conservative ranking penalty is half that exposure, capped at 2.`);
  const c = k.context;
  const missingContext: string[] = [];
  const contextFactor = (label: string, value: number, explanation: string) => add(label, c?.includedInForecast ? 0 : value, explanation + (c?.includedInForecast ? ' Already included in attempts/makes; no extra preference.' : ' Context preference only; projected points unchanged.'));
  if (c?.offense) contextFactor('Offensive drive quality', .3 * clamp((c.offense.drivesPerGame * c.offense.scoringDriveRate - 4) / 4), `${c.offense.drivesPerGame} drives/game, ${round(c.offense.scoringDriveRate * 100)}% scoring drives.`);
  else missingContext.push('Offensive drive quality unavailable; no advantage assumed.');
  if (c?.opponent) contextFactor('Opponent red zone', .25 * clamp((.6 - c.opponent.redZoneTouchdownRate) / .4), `${round(c.opponent.redZoneTouchdownRate * 100)}% opponent red-zone TD rate; lower rates favor stalled drives.`);
  else missingContext.push('Opponent red-zone tendencies unavailable; no advantage assumed.');
  const closed = c?.stadium && ['indoor', 'retractable-closed'].includes(c.stadium.roof);
  if (!c?.stadium) missingContext.push('Stadium/roof context unavailable; weather exposure is unknown.');
  else if (closed) contextFactor('Stadium and weather', 0, `${c.stadium.name}: ${c.stadium.roof}; outdoor weather penalties do not apply.`);
  else if (c.weather) contextFactor('Stadium and weather', -.4 * clamp((Math.max(0, c.weather.windMph - 10) / 20 + c.weather.precipitationProbability + Math.max(0, 32 - c.weather.temperatureF) / 32) / 3, 0, 1), `${c.stadium.name}: ${c.stadium.roof}, ${c.weather.windMph} mph wind, ${round(c.weather.precipitationProbability * 100)}% precipitation, ${c.weather.temperatureF}°F.`);
  else missingContext.push('Outdoor weather unavailable; no weather advantage assumed.');
  if (c?.game) {
    contextFactor('Implied scoring environment', .2 * clamp((c.game.impliedTeamPoints - 24) / 12), `${c.game.source} (licensed): ${c.game.impliedTeamPoints} implied team points.`);
    contextFactor('Game script', -.15 * clamp(c.game.spread / 14), `${c.game.source}: team spread ${c.game.spread}; large underdogs may need touchdowns instead of field goals.`);
  } else missingContext.push('Licensed game script and implied scoring unavailable; no market input used.');
  return { forecast: k, rankingAdjustment: round(sum(factors.map(f => f.value))), factors, missingContext };
}

/** Kicker forecasts have no generic role/matchup multiplier; only availability can zero them. */
export function unavailableKicker(value: KickerBreakdown, note: string): KickerBreakdown {
  return { ...value, expectedPoints: 0, missDownside: 0, fieldGoalMissPoints: 0, patMissPoints: 0, patPoints: 0,
    distances: value.distances.map(d => ({ ...d, makePoints: 0, missPoints: 0 })),
    availabilityNote: `${note} Counts below describe the provider forecast before availability.`,
    explanation: `0 expected points and 0 miss downside after availability. ${note}`,
  };
}
