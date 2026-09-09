/**
 * Individual special-teams (`st_*`) raw forecast contract for a rostered player.
 *
 * Sleeper scores return production twice over, under two different families of rules that belong to
 * two different fantasy entities. The team `def_st_*` rules pay the D/ST unit; the individual `st_*`
 * rules pay a rostered returner on their own stat line. The live map prices them differently —
 * `def_st_fum_rec` is 1 and `st_fum_rec` is 2 — so the two families are kept strictly apart, in the
 * schema and at the scoring boundary.
 *
 * A provider supplies expected counts only, and declares which categories it actually models. An
 * unmodeled category is *unknown*, never zero: nothing is added for it, no bonus is invented for it,
 * and the projection is marked as having incomplete special-teams coverage so that a comparison
 * involving a return specialist can disclose what is missing instead of quietly resolving it.
 */

export const SPECIAL_TEAMS_CATEGORIES = ['touchdowns', 'forcedFumbles', 'fumbleRecoveries'] as const;
export type SpecialTeamsCategory = typeof SPECIAL_TEAMS_CATEGORIES[number];

/** The individual Sleeper rule each category maps to. Scored by a rostered player, never by a unit. */
export const INDIVIDUAL_SPECIAL_TEAMS_STATS: Readonly<Record<SpecialTeamsCategory, string>> = Object.freeze({
  touchdowns: 'st_td', forcedFumbles: 'st_ff', fumbleRecoveries: 'st_fum_rec',
});
/** The team counterpart of each category. Scored by the `DEF` unit, never by a rostered player. */
export const TEAM_SPECIAL_TEAMS_STATS: Readonly<Record<SpecialTeamsCategory, string>> = Object.freeze({
  touchdowns: 'def_st_td', forcedFumbles: 'def_st_ff', fumbleRecoveries: 'def_st_fum_rec',
});
export const SPECIAL_TEAMS_LABELS: Readonly<Record<SpecialTeamsCategory, string>> = Object.freeze({
  touchdowns: 'Return touchdowns', forcedFumbles: 'Special-teams forced fumbles', fumbleRecoveries: 'Special-teams fumble recoveries',
});
/**
 * Every individual special-teams rule, including the solo coverage tackle this contract does not
 * model as a category. A team stat line that supplies any of them is refused.
 */
export const INDIVIDUAL_SPECIAL_TEAMS_KEYS: readonly string[] = Object.freeze([
  ...SPECIAL_TEAMS_CATEGORIES.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]), 'st_tkl_solo',
]);
/** Every team special-teams rule. A rostered player's stat line that supplies any of them is refused. */
export const TEAM_SPECIAL_TEAMS_KEYS: readonly string[] = Object.freeze([
  ...SPECIAL_TEAMS_CATEGORIES.map(category => TEAM_SPECIAL_TEAMS_STATS[category]), 'def_st_tkl_solo',
]);

/** Depth-chart standing in one return phase, as designated by the forecast source. */
export type ReturnDutyStatus = 'primary' | 'committee' | 'situational' | 'none' | 'unknown';
/**
 * Return duty behind the counts. Never converted to points and never a ranking bonus: it exists so a
 * comparison can say whether the missing categories could plausibly matter for *this* player.
 */
export interface ReturnRole {
  kickReturns: ReturnDutyStatus;
  puntReturns: ReturnDutyStatus;
  /** Expected combined return opportunities per game. Workload only; the league scores none of it. */
  expectedReturns?: number;
}

/** Which categories the provider models. `false` means unknown for that category, never zero. */
export type SpecialTeamsCoverage = Readonly<Record<SpecialTeamsCategory, boolean>>;

/**
 * Expected individual special-teams counts for one scored scenario.
 *
 * A category's count is supplied when and only when `coverage` declares it modeled. Supplying a
 * count for an unmodeled category, or omitting one the coverage claims, is a contradiction the
 * boundary refuses rather than resolves.
 */
export interface IndividualSpecialTeamsForecast {
  /** Expected `st_td`: kick, punt, blocked-kick and fumble return touchdowns by this player. */
  touchdowns?: number;
  /** Expected `st_ff`: fumbles this player forces in the kicking game. */
  forcedFumbles?: number;
  /** Expected `st_fum_rec`: kicking-game fumbles this player recovers, including their own muffs. */
  fumbleRecoveries?: number;
  coverage: SpecialTeamsCoverage;
  returnRole?: ReturnRole;
}

/** `complete` and `not-scored` are the only states in which nothing about return scoring is missing. */
export type SpecialTeamsCoverageStatus = 'complete' | 'partial' | 'absent' | 'not-scored';
/** Whether return duty could decide a comparison for this player, and whether that is even knowable. */
export type ReturnRelevance = 'designated' | 'unknown' | 'not-relevant';

export interface SpecialTeamsComponent {
  category: SpecialTeamsCategory;
  label: string;
  /** The individual rule. Its team counterpart is named separately and never scored here. */
  stat: string;
  teamStat: string;
  /** Expected count, or null when the provider does not model this category. Null is not zero. */
  amount: number | null;
  /** This league's live rate. Null when the synchronized snapshot defines no such rule at all. */
  rate: number | null;
  modeled: boolean;
  /** True when this league's own rules pay the rule a non-zero rate. */
  scored: boolean;
  /** Points contributed. Always 0 for an unmodeled category: an unknown count is never estimated. */
  points: number;
  explanation: string;
}

export interface SpecialTeamsBreakdown {
  /**
   * Attribution guard. This breakdown belongs to a rostered player's own stat line; a `DEF` unit's
   * return events are a `DefenseBreakdown.specialTeamsPoints`, produced from the `def_st_*` rules.
   */
  entity: 'individual-player';
  components: SpecialTeamsComponent[];
  coverage: SpecialTeamsCoverageStatus;
  /** Categories this league scores that the forecast does not model. Unknown, never assumed zero. */
  uncovered: SpecialTeamsCategory[];
  /**
   * Categories whose Sleeper rule the synchronized snapshot does not define at all. Their value is
   * unknown, not zero, so nothing is assumed about them in either direction.
   */
  undefinedRules: SpecialTeamsCategory[];
  /** Points from the modeled categories only, already part of the league-scored total. */
  expectedPoints: number;
  /** Any other individual `st_*` rule on the same stat line, such as `st_tkl_solo`. */
  otherPoints: number;
  returnRole: ReturnRole | null;
  relevance: ReturnRelevance;
  /**
   * Always 0. Unmodeled return upside never becomes ranking points: a speculative return touchdown
   * may not lift a player above someone this league's rules actually score higher.
   */
  rankingAdjustment: 0;
  /** One line per uncovered category, naming the league's own rate and declining to estimate it. */
  uncertainty: string[];
  /**
   * The same gap condensed to one sentence for an uncertainty list, or null when nothing is missing.
   * A list graded by how many entries it holds must not be skewed by how verbose one source is.
   */
  coverageNote: string | null;
  availabilityNote?: string;
  explanation: string;
}

/** True when a projection is missing special-teams scoring this league actually pays for. */
export const specialTeamsIncomplete = (value: SpecialTeamsBreakdown | undefined): boolean =>
  value !== undefined && (value.coverage === 'partial' || value.coverage === 'absent');

/**
 * Whether return duty is worth naming when this player is compared with another.
 *
 * A declared return role makes the missing categories concrete. An undeclared one makes them
 * unknowable, which is itself worth disclosing — silence would read as "this player does not return
 * kicks", which the forecast never said.
 */
export const returnDutyRelevant = (value: SpecialTeamsBreakdown | undefined): boolean =>
  value !== undefined && value.relevance !== 'not-relevant' && specialTeamsIncomplete(value);
