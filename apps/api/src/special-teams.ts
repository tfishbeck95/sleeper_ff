import {
  INDIVIDUAL_SPECIAL_TEAMS_KEYS, INDIVIDUAL_SPECIAL_TEAMS_STATS, SPECIAL_TEAMS_CATEGORIES as CATEGORIES,
  SPECIAL_TEAMS_LABELS, TEAM_SPECIAL_TEAMS_KEYS, TEAM_SPECIAL_TEAMS_STATS,
  type IndividualSpecialTeamsForecast, type ReturnDutyStatus, type ReturnRelevance, type ReturnRole,
  type ScoredPoints, type ScoringRules, type SpecialTeamsBreakdown, type SpecialTeamsCategory,
  type SpecialTeamsComponent, type SpecialTeamsCoverageStatus,
} from '@sleeper/domain';

/**
 * Individual special teams for a rostered player.
 *
 * Two rules govern everything here. The first is identity: the `st_*` family belongs to a rostered
 * player and the `def_st_*` family to the `DEF` unit, and no entity may carry both, so one real
 * return touchdown is never paid twice inside one lineup slot. The second is honesty about absence:
 * a category the provider does not model is unknown, so it contributes nothing, invents nothing, and
 * is reported as incomplete coverage wherever the projection is used to rank or compare players.
 */

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
const round = (v: number) => Math.round(v * 100) / 100;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const list = (values: string[]) => values.reduce((text, value, index, all) => index === 0 ? value : `${text}${index === all.length - 1 ? ' and ' : ', '}${value}`, '');
const DUTIES: readonly ReturnDutyStatus[] = ['primary', 'committee', 'situational', 'none', 'unknown'];
function keys(v: Record<string, unknown>, allowed: readonly string[], what: string) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error(`${what} contains an unknown field; supply the modeled special-teams counts, a coverage declaration and return role only.`);
}

/** Sanity ceilings for one game's expected count. A per-game return touchdown is a small fraction. */
export const SPECIAL_TEAMS_CEILINGS: Readonly<Record<SpecialTeamsCategory, number>> = Object.freeze({
  touchdowns: .5, forcedFumbles: 1, fumbleRecoveries: 1,
});
/** Expected combined kick and punt returns in one game. Workload only; the league scores none of it. */
export const MAX_EXPECTED_RETURNS = 12;

/** Runs at both the file adapter and the scoring boundary, including direct in-process callers. */
export function validateIndividualSpecialTeams(value: unknown): asserts value is IndividualSpecialTeamsForecast {
  if (!object(value)) throw new Error('Individual special-teams forecast requires a coverage declaration for return touchdowns, forced fumbles and fumble recoveries.');
  keys(value, [...CATEGORIES, 'coverage', 'returnRole'], 'Individual special-teams forecast');
  if (!object(value.coverage)) throw new Error('Individual special-teams coverage must declare, for every category, whether this provider models it. An undeclared category is unknown, not zero.');
  keys(value.coverage, CATEGORIES, 'Individual special-teams coverage');
  for (const category of CATEGORIES) {
    const stat = INDIVIDUAL_SPECIAL_TEAMS_STATS[category];
    const modeled = value.coverage[category];
    if (typeof modeled !== 'boolean') throw new Error(`Individual special-teams coverage for ${stat} must be true or false; omitting it would leave an unknown category looking like a zero.`);
    const supplied = value[category];
    // The declaration and the counts must agree: a count for an unmodeled category, or a modeled
    // category with no count, would leave a reader unable to tell an expectation from a gap.
    if (modeled && (!count(supplied) || supplied > SPECIAL_TEAMS_CEILINGS[category])) throw new Error(`${SPECIAL_TEAMS_LABELS[category]} (${stat}) is declared modeled, so it requires a finite nonnegative expected count for one game, at most ${SPECIAL_TEAMS_CEILINGS[category]}.`);
    if (!modeled && supplied !== undefined) throw new Error(`${SPECIAL_TEAMS_LABELS[category]} (${stat}) supplies a count while declaring the category unmodeled. Declare it modeled or omit the count; an unmodeled category is unknown, not zero.`);
  }
  if (value.returnRole !== undefined) validateReturnRole(value.returnRole);
}

function validateReturnRole(value: unknown): void {
  if (!object(value)) throw new Error('Return role requires a designated kick-return and punt-return status.');
  keys(value, ['kickReturns', 'puntReturns', 'expectedReturns'], 'Return role');
  for (const phase of ['kickReturns', 'puntReturns'] as const) {
    if (!DUTIES.includes(value[phase] as ReturnDutyStatus)) throw new Error(`Return role ${phase} must be one of ${DUTIES.join(', ')}.`);
  }
  if (value.expectedReturns !== undefined) {
    if (!count(value.expectedReturns) || value.expectedReturns > MAX_EXPECTED_RETURNS) throw new Error(`Expected returns must be a finite nonnegative count for one game, at most ${MAX_EXPECTED_RETURNS}.`);
    if (value.expectedReturns > 0 && value.kickReturns === 'none' && value.puntReturns === 'none') throw new Error('Expected returns above zero contradict a return role with no kick-return and no punt-return duty.');
  }
}

/** Canonical Sleeper counts for the modeled categories only. An unmodeled category writes no key. */
export function individualSpecialTeamsStats(forecast: IndividualSpecialTeamsForecast): Record<string, number> {
  const result: Record<string, number> = {};
  for (const category of CATEGORIES) if (forecast.coverage[category]) result[INDIVIDUAL_SPECIAL_TEAMS_STATS[category]] = forecast[category]!;
  return result;
}

/**
 * Identity and reconciliation for one rostered player's stat line.
 *
 * The team `def_st_*` family is refused outright: those points belong to the `DEF` entity, and a
 * player's line that carried them would pay one real return event on two rosters at two different
 * rates. A raw `st_*` key requires the declaring forecast, so that a supplied count is never
 * indistinguishable from an unmodeled category, and overlapping counts must agree exactly.
 */
export function normalizeSpecialTeamsStats(rules: ScoringRules, stats: Record<string, number>, forecast: IndividualSpecialTeamsForecast | undefined, name: string): Record<string, number> {
  for (const key of TEAM_SPECIAL_TEAMS_KEYS) {
    if (Object.hasOwn(stats, key)) throw new Error(`${name} supplies "${key}", a team special-teams rule that belongs to the D/ST entity. A rostered player's return events score ${CATEGORIES.map(c => INDIVIDUAL_SPECIAL_TEAMS_STATS[c]).join(', ')} on their own line; the two families pay different rates and are never combined on one entity.`);
  }
  const present = INDIVIDUAL_SPECIAL_TEAMS_KEYS.filter(key => key !== 'st_tkl_solo' && Object.hasOwn(stats, key));
  if (!forecast) {
    if (present.length) throw new Error(`${name} supplies ${present.join(', ')} without an individual special-teams forecast. Declare which categories this provider models, so an unmodeled category is never read as an expected zero.`);
    return { ...stats };
  }
  validateIndividualSpecialTeams(forecast);
  const canonical = individualSpecialTeamsStats(forecast);
  const normalized = { ...stats };
  for (const key of present) {
    if (!count(stats[key])) throw new Error(`${name} ${key} must be a finite nonnegative expected count.`);
    if (!Object.hasOwn(canonical, key)) throw new Error(`${name} supplies "${key}" while its individual special-teams coverage declares that category unmodeled. The two statements cannot both be true.`);
  }
  for (const [key, amount] of Object.entries(canonical)) {
    if (Object.hasOwn(stats, key) && !close(stats[key], amount)) throw new Error(`${name} ${key} conflicts with its individual special-teams forecast; overlapping counts must agree.`);
    // Inactive/absent scoring keys are not forced into the generic raw-stat boundary.
    delete normalized[key];
    if (rules.knows(key)) normalized[key] = amount;
  }
  return normalized;
}

function relevanceOf(role: ReturnRole | undefined): ReturnRelevance {
  if (!role) return 'unknown';
  const duties = [role.kickReturns, role.puntReturns];
  if (duties.some(duty => duty === 'primary' || duty === 'committee' || duty === 'situational')) return 'designated';
  return duties.every(duty => duty === 'none') ? 'not-relevant' : 'unknown';
}

const describeRole = (role: ReturnRole): string => {
  const phase = (label: string, duty: ReturnDutyStatus) => duty === 'unknown' ? `${label} duty unknown` : duty === 'none' ? `no ${label}` : `${duty} ${label}`;
  return `${phase('kick returns', role.kickReturns)}, ${phase('punt returns', role.puntReturns)}${role.expectedReturns == null ? '' : ` on ${round(role.expectedReturns)} expected returns per game`}`;
};

/**
 * Attribution from the shared league score, never a second scoring pass.
 *
 * Called for every non-`DEF` scenario, including when no forecast was supplied, because "this
 * league scores return touchdowns and the provider models none of them" is exactly the state that
 * must be visible rather than silently equal to zero.
 */
export function withSpecialTeams(rules: ScoringRules, scored: ScoredPoints, forecast: IndividualSpecialTeamsForecast | undefined): ScoredPoints {
  // A rule this league's snapshot does not define at all has a null rate: unknown, not zero.
  const rateOf = (stat: string) => rules.knows(stat) ? rules.settings[stat] ?? 0 : null;
  // Read back out of the total this league already produced, so a component can never report points
  // the total does not contain. A stat line that never carried the count reports 0, never `amount ×
  // rate`, because inventing the product is exactly the failure this contract exists to prevent.
  const scoredPoints = (stat: string) => sum(scored.contributions.filter(c => c.stat === stat).map(c => c.points));
  const components: SpecialTeamsComponent[] = CATEGORIES.map(category => {
    const stat = INDIVIDUAL_SPECIAL_TEAMS_STATS[category];
    const teamStat = TEAM_SPECIAL_TEAMS_STATS[category];
    const rate = rateOf(stat);
    const modeled = forecast?.coverage[category] === true;
    const amount = modeled ? forecast![category]! : null;
    const label = SPECIAL_TEAMS_LABELS[category];
    const scoredHere = rate !== null && rate !== 0;
    const points = modeled && rate !== null ? scoredPoints(stat) : 0;
    const explanation = rate === null
      ? `${label}: this league's synchronized scoring does not define ${stat}, so what it pays is unknown rather than zero.`
      : modeled
        ? `${label}: ${round(amount!)} expected × ${rate} = ${round(points)} points from ${stat}.`
        : scoredHere
          ? `${label}: not modeled by this forecast. Your league pays ${rate} per ${stat}, so this projection omits that scoring instead of valuing it at zero, and no expected count is invented to fill the gap.`
          : `${label}: this league scores ${stat} at 0, so modeling it would change nothing.`;
    return { category, label, stat, teamStat, amount, rate, modeled, scored: scoredHere, points, explanation };
  });
  const undefinedRules = components.filter(c => c.rate === null).map(c => c.category);
  const payable = components.filter(c => c.scored);
  const uncovered = payable.filter(c => !c.modeled).map(c => c.category);
  const coverage: SpecialTeamsCoverageStatus = !payable.length ? 'not-scored'
    : uncovered.length === 0 ? 'complete'
      : uncovered.length === payable.length ? 'absent' : 'partial';
  const expectedPoints = round(sum(components.map(c => c.points)));
  const otherPoints = round(sum(scored.contributions
    .filter(c => INDIVIDUAL_SPECIAL_TEAMS_KEYS.includes(c.stat) && !CATEGORIES.some(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category] === c.stat))
    .map(c => c.points)));
  const role = forecast?.returnRole;
  const relevance = relevanceOf(role);
  const uncertainty = [
    ...components.filter(c => c.rate === null).map(c => c.explanation),
    ...components.filter(c => c.scored && !c.modeled).map(c => c.explanation),
  ];
  if (uncovered.length && relevance === 'designated') uncertainty.push(`${describeRole(role!)}: return duty is part of this player's role, so the missing ${uncovered.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]).join(', ')} scoring is the part of the projection most likely to matter — and the part least safe to estimate.`);
  if (uncovered.length && relevance === 'unknown') uncertainty.push('No return role was supplied, so whether this player returns kicks or punts at all is unknown. Treat the missing special-teams categories as unresolved rather than as evidence that they do not apply.');
  const named = uncovered.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]).join(', ');
  const coverageNote = uncovered.length
    ? `Incomplete special-teams coverage: this forecast does not model ${named}, which your league does score. `
      + `${relevance === 'designated' ? `${describeRole(role!)} makes that gap a real one for this player. ` : relevance === 'unknown' ? 'No return role was supplied, so whether the gap matters here is unknown. ' : ''}`
      + 'The missing scoring is unknown rather than zero, and no return upside is added to any ranking.'
    : null;
  const breakdown: SpecialTeamsBreakdown = {
    entity: 'individual-player', components, coverage, uncovered, undefinedRules,
    expectedPoints, otherPoints, returnRole: role ?? null, relevance, rankingAdjustment: 0, uncertainty, coverageNote,
    explanation: describe(coverage, expectedPoints, otherPoints, uncovered, relevance, role),
  };
  // The coverage gap is always recorded. It joins the manager-facing sentence only when it bears on
  // this player's decision — points actually scored, or a return role that makes the gap concrete —
  // so a league-wide absence of return modeling is disclosed once, not appended to every projection.
  const material = coverage !== 'not-scored' && (expectedPoints !== 0 || otherPoints !== 0 || relevance === 'designated');
  return { ...scored, specialTeams: breakdown, explanation: material ? `${scored.explanation}. ${breakdown.explanation}` : scored.explanation };
}

function describe(
  coverage: SpecialTeamsCoverageStatus, expectedPoints: number, otherPoints: number,
  uncovered: SpecialTeamsCategory[], relevance: ReturnRelevance, role: ReturnRole | undefined,
): string {
  const other = otherPoints === 0 ? '' : ` A further ${round(otherPoints)} points come from other individual special-teams rules on the same stat line.`;
  const named = list(uncovered.map(category => `${SPECIAL_TEAMS_LABELS[category].toLowerCase()} (${INDIVIDUAL_SPECIAL_TEAMS_STATS[category]})`));
  const who = role ? ` Return role: ${describeRole(role)}.` : '';
  if (coverage === 'not-scored') return `Special teams: this league scores no individual return rule, so nothing is missing from this projection.${other}`;
  if (coverage === 'complete') return `Special teams: ${expectedPoints} points from this player's own return scoring, every category this league pays for modeled by the forecast.${other}${who}`;
  const shortfall = coverage === 'absent'
    ? `Special teams: this forecast models none of the individual return scoring this league pays for, so ${named} are all missing from the total.`
    : `Special teams: ${expectedPoints} points from the modeled categories, with ${named} not modeled and therefore missing from the total.`;
  const stance = relevance === 'designated'
    ? ' This player has a designated return role, so the gap is a real one; it is disclosed rather than estimated, and no return upside is added to any ranking.'
    : relevance === 'not-relevant'
      ? ' This player is designated as having no return duty, so the gap is unlikely to matter here.'
      : ' No return role was supplied, so whether the gap matters for this player cannot be determined from the forecast.';
  return `${shortfall} The missing scoring is unknown, not zero.${stance}${other}${who}`;
}

/** Post-scoring adjustments scale the modeled points; coverage and role are facts and do not scale. */
export function scaleSpecialTeams(value: SpecialTeamsBreakdown, multiplier: number, note?: string): SpecialTeamsBreakdown {
  if (multiplier === 1) return value;
  const components = value.components.map(c => ({ ...c, points: round(c.points * multiplier) }));
  const scaled: SpecialTeamsBreakdown = {
    ...value, components,
    expectedPoints: round(value.expectedPoints * multiplier), otherPoints: round(value.otherPoints * multiplier),
  };
  if (multiplier !== 0) return scaled;
  return { ...scaled,
    availabilityNote: `${note ?? 'Availability zeroes this week.'} The categories below describe the provider forecast before availability.`,
    explanation: `Special teams: 0 points after availability. ${value.explanation}`,
  };
}

/**
 * What is worth saying when two players are ranked against each other.
 *
 * Return upside never moves a ranking — `rankingAdjustment` is 0 by construction — so the only thing
 * a comparison can honestly do is name what the league-scored margin does not contain. That matters
 * in both directions: an unquantified gap on the *lower*-scoring player is exactly the argument a
 * manager might otherwise make to themselves for starting a return specialist anyway.
 */
export function specialTeamsCautions(higher: { name: string; scored: ScoredPoints }, lower: { name: string; scored: ScoredPoints }, margin: number): string[] {
  const cautions: string[] = [];
  const rule = (value: SpecialTeamsBreakdown) => value.uncovered.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]).join(', ');
  for (const [side, other, behind] of [[lower, higher, true], [higher, lower, false]] as const) {
    const value = side.scored.specialTeams;
    // Only a declared return role makes the gap concrete enough to name here. A league-wide absence
    // of return modeling is disclosed once, as a report warning, rather than on every comparison.
    if (!value || !value.uncovered.length || value.relevance !== 'designated') continue;
    cautions.push(`${side.name} has a designated return role (${describeRole(value.returnRole!)}) and this forecast does not model ${rule(value)}. `
      + (behind
        ? `The ${margin}-point margin behind ${other.name} therefore excludes return scoring for ${side.name}. That is a disclosed unknown, not a hidden edge: a return touchdown nobody projected is not a reason to start the lower-scoring player.`
        : `The ${margin}-point margin over ${other.name} therefore excludes return scoring for ${side.name} as well, so the gap does not widen the case for this swap.`));
  }
  return cautions;
}
