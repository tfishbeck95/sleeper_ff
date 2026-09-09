import { EXPECTED_SCORING, liveScoring, type ScoringConfiguration } from '../scoring.js';
import { interpretScoring, type ScoringRules } from '../league-rules.js';

/**
 * The complete `scoring_settings` object returned by the live league, captured verbatim.
 *
 *   GET https://api.sleeper.app/v1/league/1394890490725273600
 *   "HardKnockers" · 2026 regular season · 12 rosters
 *   Captured 2026-09-09T03:10:55Z · 148 keys, 37 of them non-zero
 *
 * Sleeper serializes every rate as a float ("pass_td": 4.0); JSON parsing yields the numbers below.
 * Key names come from this response, not from docs/league-scoring-rules.txt, which transcribes the
 * same 37 active rules from screenshots and omits the 111 keys Sleeper sends at zero.
 *
 * Regression tests and configuration reconciliation only. This fixture is deliberately absent from
 * the package entry point: league selection and synchronization must read the selected league's own
 * response, so that a commissioner's change is observed rather than assumed.
 */
export const LIVE_LEAGUE_SCORING_SOURCE = Object.freeze({
  leagueId: '1394890490725273600',
  name: 'HardKnockers',
  season: '2026',
  seasonType: 'regular',
  endpoint: 'https://api.sleeper.app/v1/league/1394890490725273600',
  capturedAt: '2026-09-09T03:10:55Z',
});

export const LIVE_SCORING_SETTINGS = Object.freeze({
  // Passing (pass_int is the interception thrown, not the defensive takeaway)
  pass_yd: 0.04, pass_td: 4, pass_2pt: 2, pass_int: -2,
  // Rushing
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  // Receiving
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  // Kicking: every distance tier is configured separately and no generic fgm rule is active
  xpm: 1, xpmiss: -1, fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
  fgm_50_59: 5, fgm_60p: 6, fgmiss: -1,
  // Team defense
  int: 2, fum_rec: 1, ff: 1, safe: 2, blk_kick: 2, sack: 1,
  def_td: 6, pts_allow_0: 8, yds_allow_0_100: 3,
  // Team special teams (the D/ST unit)
  def_st_td: 6, def_st_ff: 1, def_st_fum_rec: 1,
  // Individual special teams (a rostered player); st_fum_rec is 2, twice its team counterpart
  st_td: 6, st_ff: 1, st_fum_rec: 2,
  // Fumbles
  fum_lost: -2, fum_rec_td: 6,

  // Present in the live response at zero. Sleeper sends every rule it knows about, so these are
  // configured-and-off rather than absent, and are retained so a later change is visible as a
  // value change rather than as a new key.
  // Yardage, first-down and position bonuses
  bonus_def_fum_td_50p: 0, bonus_def_int_td_50p: 0, bonus_fd_qb: 0, bonus_fd_rb: 0, bonus_fd_te: 0, bonus_fd_wr: 0,
  bonus_pass_cmp_25: 0, bonus_pass_yd_300: 0, bonus_pass_yd_400: 0, bonus_rec_rb: 0, bonus_rec_te: 0, bonus_rec_wr: 0,
  bonus_rec_yd_100: 0, bonus_rec_yd_200: 0, bonus_rush_att_20: 0, bonus_rush_rec_yd_100: 0, bonus_rush_rec_yd_200: 0, bonus_rush_td_qb: 0,
  bonus_rush_yd_100: 0, bonus_rush_yd_200: 0, bonus_sack_2p: 0, bonus_tkl_10p: 0,
  // Individual defensive players
  idp_blk_kick: 0, idp_def_td: 0, idp_ff: 0, idp_fum_rec: 0, idp_fum_ret_yd: 0, idp_int: 0,
  idp_int_ret_yd: 0, idp_pass_def: 0, idp_pass_def_3p: 0, idp_qb_hit: 0, idp_sack: 0, idp_sack_yd: 0,
  idp_safe: 0, idp_tkl: 0, idp_tkl_ast: 0, idp_tkl_loss: 0, idp_tkl_solo: 0,
  // Alternative kicking rules
  fgm: 0, fgm_50p: 0, fgm_yds: 0, fgm_yds_over_30: 0, fgmiss_0_19: 0, fgmiss_20_29: 0,
  fgmiss_30_39: 0, fgmiss_40_49: 0, fgmiss_50_59: 0, fgmiss_50p: 0, fgmiss_60p: 0,
  // Passing
  pass_att: 0, pass_cmp: 0, pass_cmp_40p: 0, pass_fd: 0, pass_inc: 0, pass_int_td: 0,
  pass_sack: 0, pass_td_40p: 0, pass_td_50p: 0,
  // Rushing
  rush_40p: 0, rush_att: 0, rush_fd: 0, rush_td_40p: 0, rush_td_50p: 0,
  // Receiving
  rec_0_4: 0, rec_10_19: 0, rec_20_29: 0, rec_30_39: 0, rec_40p: 0, rec_5_9: 0,
  rec_fd: 0, rec_td_40p: 0, rec_td_50p: 0,
  // Points allowed tiers
  pts_allow: 0, pts_allow_14_20: 0, pts_allow_1_6: 0, pts_allow_21_27: 0, pts_allow_28_34: 0, pts_allow_35p: 0,
  pts_allow_7_13: 0,
  // Yards allowed tiers
  yds_allow: 0, yds_allow_100_199: 0, yds_allow_200_299: 0, yds_allow_300_349: 0, yds_allow_350_399: 0, yds_allow_400_449: 0,
  yds_allow_450_499: 0, yds_allow_500_549: 0, yds_allow_550p: 0,
  // Team defense and special teams
  def_2pt: 0, def_3_and_out: 0, def_4_and_stop: 0, def_forced_punts: 0, def_kr_yd: 0, def_pass_def: 0,
  def_pr_yd: 0, def_st_tkl_solo: 0,
  // Tackles
  tkl: 0, tkl_ast: 0, tkl_loss: 0, tkl_solo: 0,
  // Return yardage and remaining unused rules
  blk_kick_ret_yd: 0, fg_ret_yd: 0, fum: 0, fum_ret_yd: 0, int_ret_yd: 0, kr_yd: 0,
  pr_yd: 0, qb_hit: 0, sack_yd: 0, st_tkl_solo: 0,
});

/** The documented categories, keyed by the section headings in docs/league-scoring-rules.txt. */
export const LIVE_SCORING_CATEGORIES = Object.freeze({
  passing: ['pass_yd', 'pass_td', 'pass_2pt', 'pass_int'],
  rushing: ['rush_yd', 'rush_td', 'rush_2pt'],
  receiving: ['rec', 'rec_yd', 'rec_td', 'rec_2pt'],
  kicking: ['xpm', 'xpmiss', 'fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50_59', 'fgm_60p', 'fgmiss'],
  teamDefense: ['int', 'fum_rec', 'ff', 'safe', 'blk_kick', 'sack', 'def_td', 'pts_allow_0', 'yds_allow_0_100'],
  teamSpecialTeams: ['def_st_td', 'def_st_ff', 'def_st_fum_rec'],
  individualSpecialTeams: ['st_td', 'st_ff', 'st_fum_rec'],
  fumbles: ['fum_lost', 'fum_rec_td'],
} as const satisfies Record<string, readonly (keyof typeof LIVE_SCORING_SETTINGS)[]>);

/** Keys the live league sends that the transcribed reference does not describe. */
export const LIVE_UNDOCUMENTED_KEYS = Object.freeze(
  Object.keys(LIVE_SCORING_SETTINGS).filter(key => !Object.hasOwn(EXPECTED_SCORING, key)),
);

/** A validated configuration built from the capture, as synchronization would produce from this league. */
export function liveScoringFixture(synchronizedAt = LIVE_LEAGUE_SCORING_SOURCE.capturedAt, overrides: Readonly<Record<string, number>> = {}): ScoringConfiguration {
  return liveScoring({ ...LIVE_SCORING_SETTINGS, ...overrides }, synchronizedAt);
}

export function liveScoringRulesFixture(overrides?: Readonly<Record<string, number>>): ScoringRules {
  return interpretScoring([], liveScoringFixture(LIVE_LEAGUE_SCORING_SOURCE.capturedAt, overrides));
}
