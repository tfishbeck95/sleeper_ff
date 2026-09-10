import { INDIVIDUAL_SPECIAL_TEAMS_STATS, KICKER_DISTANCE_BANDS, POINTS_ALLOWED_BUCKETS, SPECIAL_TEAMS_CATEGORIES, TEAM_SPECIAL_TEAMS_STATS, YARDS_ALLOWED_BUCKETS, type ScoringRules, type SpecialTeamsCoverage } from '@sleeper/domain';

/**
 * Scored-category coverage against the *live* league.
 *
 * A feed is not complete in the abstract; it is complete or incomplete relative to one commissioner's
 * rule set. A league that pays `st_fum_rec` needs return-fumble forecasts and a league that does not
 * never misses them. So coverage is computed from the synchronized scoring snapshot, and a category
 * the league pays but the feed does not model is *recorded*, never inferred, filled or rounded to
 * zero — the same rule the special-teams contract already applies to its own three categories.
 */

/** Position families a scored rule can be produced by. Everything else is reported as unsupported. */
export const FAMILIES = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
export type Family = typeof FAMILIES[number];
const OFFENSE: Family[] = ['QB', 'RB', 'WR', 'TE'];
const SKILL: Family[] = ['RB', 'WR', 'TE'];

/** Exact keys first; anything unmatched falls through to the prefix rules below. */
const EXACT: Readonly<Record<string, Family[]>> = Object.freeze({
  sack: ['DEF'], int: ['DEF'], ff: ['DEF'], fum_rec: ['DEF'], safe: ['DEF'], blk_kick: ['DEF'],
  xpm: ['K'], xpmiss: ['K'], fgmiss: ['K'],
  fum: OFFENSE, fum_lost: OFFENSE, fum_rec_td: OFFENSE,
  bonus_rec_te: ['TE'],
});
const PREFIXES: ReadonlyArray<readonly [string, Family[]]> = Object.freeze([
  ['pass_', ['QB']], ['rush_', OFFENSE], ['rec_', SKILL], ['rec', SKILL],
  ['fgm', ['K']], ['fga', ['K']], ['xp', ['K']],
  ['pts_allow', ['DEF']], ['yds_allow', ['DEF']], ['def_', ['DEF']],
  ['st_', SKILL],
  ['bonus_pass', ['QB']], ['bonus_rush', OFFENSE], ['bonus_rec', SKILL], ['bonus_def', ['DEF']],
]);

/** Which position families could produce a scored rule, or an empty list when none in scope can. */
export function familiesFor(stat: string): Family[] {
  if (EXACT[stat]) return [...EXACT[stat]];
  const prefix = PREFIXES.find(([value]) => stat.startsWith(value));
  return prefix ? [...prefix[1]] : [];
}

/** Sleeper rules a validated kicker forecast necessarily supplies, whether or not the league pays them. */
export const KICKER_IMPLIED_KEYS: readonly string[] = Object.freeze([...KICKER_DISTANCE_BANDS.map(band => `fgm_${band}`), 'xpm', 'xpmiss', 'fgmiss']);
/** Sleeper rules a validated team-defense forecast necessarily supplies. */
export const DEFENSE_IMPLIED_KEYS: readonly string[] = Object.freeze([
  'sack', 'int', 'ff', 'fum_rec', 'safe', 'blk_kick', 'def_td',
  ...POINTS_ALLOWED_BUCKETS.map(bucket => `pts_allow_${bucket}`),
  ...YARDS_ALLOWED_BUCKETS.map(bucket => `yds_allow_${bucket}`),
]);
/** Only the categories a provider *declares* it models. An undeclared category supplies nothing. */
export const individualSpecialTeamsKeys = (coverage: SpecialTeamsCoverage): string[] =>
  SPECIAL_TEAMS_CATEGORIES.filter(category => coverage[category]).map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]);
export const teamSpecialTeamsKeys: readonly string[] = Object.freeze(SPECIAL_TEAMS_CATEGORIES.map(category => TEAM_SPECIAL_TEAMS_STATS[category]));

export interface FamilyCoverage {
  family: Family;
  /** Rules this league pays a non-zero rate for and this family could produce. */
  scored: string[];
  covered: string[];
  /** Scored rules no forecast in this family supplies. Unknown, never zero. */
  uncovered: string[];
  /** Covered rules whose values came from a derivation rather than from the source. */
  derived: string[];
  complete: boolean;
}

export interface CoverageReport {
  /** True only when every scored rule in scope is supplied by at least the families that produce it. */
  complete: boolean;
  families: FamilyCoverage[];
  /** Rules this league pays that no supported position family produces, such as IDP scoring. */
  unsupported: string[];
  /** Every uncovered rule, deduplicated, for the service-level check and the alert body. */
  uncovered: string[];
  summary: string;
}

/**
 * Compares what the league pays against what the feed supplies.
 *
 * Only rules with a non-zero rate count. A commissioner who sets `st_ff` to 0 has not created a
 * coverage gap by leaving the rule defined, and treating explicit zeros as obligations would report
 * permanent incompleteness for every league that trims Sleeper's defaults.
 */
export function assessCoverage(
  scoring: ScoringRules,
  supplied: Readonly<Partial<Record<Family, Iterable<string>>>>,
  derived: Iterable<string> = [],
): CoverageReport {
  const rates = scoring.settings;
  const derivedKeys = new Set(derived);
  const paid = Object.keys(rates).filter(stat => rates[stat] !== 0).sort();
  const unsupported = paid.filter(stat => familiesFor(stat).length === 0);

  const families = FAMILIES.map<FamilyCoverage>(family => {
    const available = new Set(supplied[family] ?? []);
    const scored = paid.filter(stat => familiesFor(stat).includes(family));
    const covered = scored.filter(stat => available.has(stat));
    const uncovered = scored.filter(stat => !available.has(stat));
    return { family, scored, covered, uncovered, derived: covered.filter(stat => derivedKeys.has(stat)), complete: uncovered.length === 0 };
  });

  const uncovered = [...new Set(families.flatMap(entry => entry.uncovered))].sort();
  const complete = uncovered.length === 0 && unsupported.length === 0;
  const incomplete = families.filter(entry => !entry.complete);
  const summary = complete
    ? `Every one of the ${paid.length} rules this league scores is supplied by the feed.`
    : [
      `${uncovered.length} of the ${paid.length} rules this league scores are not supplied: ${uncovered.join(', ') || 'none'}.`,
      incomplete.length ? `Incomplete families: ${incomplete.map(entry => `${entry.family} (${entry.uncovered.length})`).join(', ')}.` : '',
      unsupported.length ? `${unsupported.length} scored rules have no supported position family in this application: ${unsupported.join(', ')}.` : '',
    ].filter(Boolean).join(' ');

  return { complete, families, unsupported, uncovered, summary };
}
