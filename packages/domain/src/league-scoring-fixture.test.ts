import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  EXPECTED_SCORING, INDIVIDUAL_SPECIAL_TEAMS_KEYS, INDIVIDUAL_SPECIAL_TEAMS_STATS,
  SPECIAL_TEAMS_CATEGORIES, TEAM_SPECIAL_TEAMS_KEYS, TEAM_SPECIAL_TEAMS_STATS,
} from './index.js';
import {
  LIVE_LEAGUE_SCORING_SOURCE, LIVE_SCORING_CATEGORIES, LIVE_SCORING_SETTINGS, LIVE_UNDOCUMENTED_KEYS,
  liveScoringFixture, liveScoringRulesFixture,
} from './fixtures/league-scoring.js';

const rules = liveScoringRulesFixture();
const points = (stats: Readonly<Record<string, number>>) => rules.score(stats).points;
/** Same object, indexable by the string keys the tests assert over. */
const LIVE: Readonly<Record<string, number>> = LIVE_SCORING_SETTINGS;

test('the capture reconciles with the transcribed reference on every documented rule', () => {
  for (const [key, expected] of Object.entries(EXPECTED_SCORING)) {
    assert.ok(Object.hasOwn(LIVE_SCORING_SETTINGS, key), `${key} is documented but absent from the live league`);
    assert.equal(LIVE[key], expected, key);
  }
  const active = Object.entries(LIVE_SCORING_SETTINGS).filter(([, rate]) => rate !== 0).map(([key]) => key);
  assert.deepEqual(active.sort(), Object.keys(EXPECTED_SCORING).sort());
  assert.equal(Object.keys(LIVE_SCORING_SETTINGS).length, 148);
  assert.equal(LIVE_UNDOCUMENTED_KEYS.length, 148 - active.length);
  assert.equal(LIVE_LEAGUE_SCORING_SOURCE.endpoint, `https://api.sleeper.app/v1/league/${LIVE_LEAGUE_SCORING_SOURCE.leagueId}`);
  assert.ok(Number.isFinite(Date.parse(LIVE_LEAGUE_SCORING_SOURCE.capturedAt)));
});

test('a single event in every documented category scores at its live rate', () => {
  assert.deepEqual(Object.values(LIVE_SCORING_CATEGORIES).flat().slice().sort(), Object.keys(EXPECTED_SCORING).sort());
  for (const [category, keys] of Object.entries(LIVE_SCORING_CATEGORIES)) {
    for (const key of keys) {
      assert.notEqual(LIVE[key], 0, `${category}.${key} is inactive in the live league`);
      assert.equal(points({ [key]: 1 }), LIVE[key], `${category}.${key}`);
    }
  }
});

const STAT_LINES: Record<string, [Readonly<Record<string, number>>, number]> = {
  QB: [{ pass_yd: 287, pass_td: 2, pass_2pt: 1, pass_int: 1, rush_yd: 34, rush_td: 1, fum_lost: 1 }, 26.88],
  RB: [{ rush_yd: 92, rush_td: 1, rush_2pt: 1, rec: 4, rec_yd: 31, fum_lost: 1 }, 22.3],
  WR: [{ rec: 8, rec_yd: 124, rec_td: 1, rec_2pt: 1, rush_yd: 9 }, 29.3],
  TE: [{ rec: 6, rec_yd: 58, rec_td: 1 }, 17.8],
  K: [{ xpm: 3, xpmiss: 1, fgm_0_19: 1, fgm_20_29: 1, fgm_30_39: 1, fgm_40_49: 1, fgm_50_59: 1, fgm_60p: 1, fgmiss: 1 }, 25],
  DST: [{ sack: 4, int: 2, fum_rec: 1, ff: 2, safe: 1, blk_kick: 1, def_td: 1, pts_allow_0: 1, yds_allow_0_100: 1, def_st_td: 1, def_st_ff: 1, def_st_fum_rec: 1 }, 40],
};

test('representative complete stat lines score to their hand-computed totals', () => {
  for (const [position, [line, expected]] of Object.entries(STAT_LINES)) assert.equal(points(line), expected, position);
  const { breakdown, explanation, contributions } = rules.score(STAT_LINES.QB[0]);
  assert.match(breakdown, /287 pass_yd × 0\.04 = 11\.48/);
  assert.match(breakdown, /2 pass_td × 4 = 8\.00/);
  assert.match(breakdown, /1 fum_lost × -2 = -2\.00/);
  assert.equal(breakdown.split('; ').length, Object.keys(STAT_LINES.QB[0]).length);
  assert.equal(explanation, "26.9 points under your league's full-PPR scoring");
  // Contributions are disclosed largest-first so a UI can show the drivers without re-sorting.
  assert.deepEqual(contributions.slice(0, 2).map(c => c.stat), ['pass_yd', 'pass_td']);
  assert.equal(contributions.length, Object.keys(STAT_LINES.QB[0]).length);
  // Statistics the league leaves at zero never appear as a contribution.
  assert.equal(rules.score({ ...STAT_LINES.TE[0], bonus_rec_te: 6, rec_fd: 4 }).breakdown.split('; ').length, 3);
});

test('passing touchdowns score four points, not the six carried by rushing and receiving', () => {
  assert.equal(LIVE_SCORING_SETTINGS.pass_td, 4);
  assert.equal(points({ pass_td: 3 }), 12);
  assert.equal(points({ rush_td: 3 }), 18);
  assert.equal(points({ rec_td: 3 }), 18);
  assert.notEqual(LIVE_SCORING_SETTINGS.pass_td, LIVE_SCORING_SETTINGS.rush_td);
  // No length or position bonus tops a passing touchdown up towards six.
  for (const key of ['pass_td_40p', 'pass_td_50p', 'pass_int_td', 'bonus_rush_td_qb']) assert.equal(LIVE[key], 0, key);
  assert.equal(points({ pass_td: 1, pass_td_50p: 1 }), 4);
});

test('every reception scores one point', () => {
  assert.equal(LIVE_SCORING_SETTINGS.rec, 1);
  assert.equal(rules.receptionPoints, 1);
  assert.equal(rules.receptionFormat, 'ppr');
  for (const catches of [0, 1, 5, 12]) assert.equal(points({ rec: catches }), catches);
  // Reception-count tiers and position premiums are off, so full PPR is not paid twice.
  for (const key of ['rec_0_4', 'rec_5_9', 'rec_10_19', 'rec_20_29', 'rec_30_39', 'rec_40p', 'rec_fd', 'bonus_rec_te', 'bonus_rec_rb', 'bonus_rec_wr']) assert.equal(LIVE[key], 0, key);
  assert.equal(points({ rec: 9, rec_5_9: 9, bonus_rec_wr: 9 }), 9);
});

test('an interception thrown and a lost fumble each subtract two points', () => {
  assert.equal(LIVE_SCORING_SETTINGS.pass_int, -2);
  assert.equal(LIVE_SCORING_SETTINGS.fum_lost, -2);
  assert.equal(points({ pass_int: 1 }), -2);
  assert.equal(points({ fum_lost: 1 }), -2);
  assert.equal(points({ pass_int: 2, fum_lost: 1 }), -6);
  assert.equal(points({ pass_td: 2, pass_int: 1 }), 6);
  // The thrown interception is a separate key from the defence's takeaway, which adds two.
  assert.equal(LIVE_SCORING_SETTINGS.int, 2);
  assert.equal(points({ pass_int: 1, int: 1 }), 0);
  // A fumble the offence recovers itself is not a lost fumble and carries no penalty.
  assert.equal(LIVE.fum, 0);
  assert.equal(points({ fum: 3 }), 0);
});

test('each kicker distance band scores independently', () => {
  const bands = { fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6 };
  for (const [key, expected] of Object.entries(bands)) {
    assert.equal(LIVE[key], expected, key);
    assert.equal(points({ [key]: 1 }), expected, key);
    assert.equal(points({ [key]: 2 }), expected * 2, key);
  }
  // One make in every band is paid band by band, not at a single flat rate.
  assert.equal(points(Object.fromEntries(Object.keys(bands).map(key => [key, 1]))), 24);
  assert.notEqual(24, Object.keys(bands).length * bands.fgm_0_19);
  // The flat, 50+ and distance-scaled alternatives Sleeper also sends are off, so no make is counted twice.
  for (const key of ['fgm', 'fgm_50p', 'fgm_yds', 'fgm_yds_over_30']) assert.equal(LIVE[key], 0, key);
  assert.equal(points({ fgm_50_59: 1, fgm: 1, fgm_50p: 1, fgm_yds: 55 }), 5);
  // Misses are one flat rule for field goals and one for PATs; the per-band miss rules stay off.
  assert.equal(points({ fgmiss: 2 }), -2);
  assert.equal(points({ xpm: 4, xpmiss: 1 }), 3);
  for (const key of ['fgmiss_0_19', 'fgmiss_20_29', 'fgmiss_30_39', 'fgmiss_40_49', 'fgmiss_50_59', 'fgmiss_50p', 'fgmiss_60p']) assert.equal(LIVE[key], 0, key);
  assert.equal(points({ fgmiss: 1, fgmiss_50_59: 1 }), -1);
});

test('a forced fumble and its recovery score both configured components', () => {
  assert.equal(points({ ff: 1 }), 1);
  assert.equal(points({ fum_rec: 1 }), 1);
  assert.equal(points({ ff: 1, fum_rec: 1 }), 2);
  // Returned for a score, the two takeaway components stack with the touchdown.
  assert.equal(points({ ff: 1, fum_rec: 1, fum_rec_td: 1 }), 8);
  assert.equal(points({ def_st_ff: 1, def_st_fum_rec: 1 }), 2);
  assert.equal(points({ st_ff: 1, st_fum_rec: 1 }), 3);
});

test('team and individual special-teams rules are never collapsed into one another', () => {
  const team = LIVE_SCORING_CATEGORIES.teamSpecialTeams, individual = LIVE_SCORING_CATEGORIES.individualSpecialTeams;
  assert.equal(new Set([...team, ...individual]).size, 6);
  // The recoveries are the pair that would be masked by a collapse: 1 for the unit, 2 for the player.
  assert.equal(LIVE_SCORING_SETTINGS.def_st_fum_rec, 1);
  assert.equal(LIVE_SCORING_SETTINGS.st_fum_rec, 2);
  assert.equal(points({ def_st_fum_rec: 1 }), 1);
  assert.equal(points({ st_fum_rec: 1 }), 2);
  assert.equal(points({ def_st_fum_rec: 1, st_fum_rec: 1 }), 3);
  // One of each of the six: 6 + 1 + 1 for the unit, 6 + 1 + 2 for the returner.
  assert.equal(points(Object.fromEntries([...team, ...individual].map(key => [key, 1]))), 17);
  assert.equal(points(Object.fromEntries(team.map(key => [key, 1]))), 8);
  assert.equal(points(Object.fromEntries(individual.map(key => [key, 1]))), 9);
  // Neither side is an alias of the defensive rules that share its wording.
  assert.notEqual(LIVE_SCORING_SETTINGS.st_fum_rec, LIVE_SCORING_SETTINGS.fum_rec);
  for (const key of ['def_st_tkl_solo', 'st_tkl_solo']) assert.equal(LIVE[key], 0, key);
  // Both forecast contracts read their Sleeper keys from the same maps, so a schema change cannot
  // point one family's category at the other family's rule.
  assert.deepEqual(SPECIAL_TEAMS_CATEGORIES.map(category => TEAM_SPECIAL_TEAMS_STATS[category]), [...team]);
  assert.deepEqual(SPECIAL_TEAMS_CATEGORIES.map(category => INDIVIDUAL_SPECIAL_TEAMS_STATS[category]), [...individual]);
  assert.equal(TEAM_SPECIAL_TEAMS_KEYS.some(key => INDIVIDUAL_SPECIAL_TEAMS_KEYS.includes(key)), false);
  assert.deepEqual([...TEAM_SPECIAL_TEAMS_KEYS, ...INDIVIDUAL_SPECIAL_TEAMS_KEYS].filter(key => LIVE[key] === undefined), []);
});

test('decimal yardage contributions are summed before any rounding', () => {
  const line = { pass_yd: 213, rec_yd: 87, rush_yd: 13 };
  const contributions = [213 * 0.04, 87 * 0.1, 13 * 0.1];
  assert.equal(points(line), 18.52);
  assert.equal(points(line), Math.round(contributions.reduce((sum, value) => sum + value, 0) * 100) / 100);
  // Rounding each contribution first loses the fractional yardage.
  assert.equal(contributions.map(value => Math.round(value * 10) / 10).reduce((sum, value) => sum + value, 0), 18.5);
  assert.equal(contributions.map(Math.round).reduce((sum, value) => sum + value, 0), 19);
  // Binary drift in the individual products is absorbed by the single final rounding.
  assert.notEqual(87 * 0.1, 8.7);
  const drifting = Object.entries(STAT_LINES.QB[0]).reduce((sum, [stat, amount]) => sum + amount * LIVE[stat], 0);
  assert.notEqual(drifting, 26.88);
  assert.equal(points(STAT_LINES.QB[0]), 26.88);
  assert.equal(Math.round(drifting * 100) / 100, 26.88);
  assert.equal(points({ pass_yd: 25 }), 1);
  assert.equal(points({ rush_yd: 5, rec_yd: 5 }), 1);
});

test('undocumented live keys are retained, reported and scored at their live rate', () => {
  const configuration = liveScoringFixture();
  assert.equal(configuration.kind, 'complete-live');
  assert.deepEqual(configuration.settings, { ...LIVE_SCORING_SETTINGS });
  assert.deepEqual(configuration.rawSettings, { ...LIVE_SCORING_SETTINGS });
  assert.equal(configuration.synchronizedAt, LIVE_LEAGUE_SCORING_SOURCE.capturedAt);
  // Every extra key is surfaced as informational only; none of them invalidates the snapshot.
  assert.ok(configuration.issues.every(issue => issue.kind === 'unexpected'));
  assert.deepEqual(configuration.issues.map(issue => issue.key).sort(), [...LIVE_UNDOCUMENTED_KEYS].sort());
  for (const key of LIVE_UNDOCUMENTED_KEYS) assert.equal(rules.settings[key], 0, key);
  // Retained at zero rather than dropped: a key Sleeper never sent is absent instead.
  assert.ok(Object.hasOwn(rules.settings, 'idp_sack'));
  assert.ok(!Object.hasOwn(rules.settings, 'not_a_sleeper_rule'));
  assert.equal(points({ idp_sack: 3, bonus_rec_te: 4, pts_allow_35p: 1, not_a_sleeper_rule: 9 }), 0);
  // The scorer reads rates from the response, not an allowlist, so a commissioner switching one on scores here.
  const enabled = liveScoringRulesFixture({ bonus_rec_te: 0.5, pts_allow_35p: -4, idp_sack: 1 });
  assert.equal(enabled.configuration.kind, 'complete-live');
  assert.equal(enabled.score({ rec: 6, bonus_rec_te: 6, pts_allow_35p: 1, idp_sack: 2 }).points, 7);
});

test('the capture stays confined to tests and never reaches production league selection', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const sources: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) sources.push(path);
    }
  };
  await walk(root);
  const importers: string[] = [];
  for (const path of sources) if ((await readFile(path, 'utf8')).includes('fixtures/league-scoring')) importers.push(path.slice(root.length));
  assert.ok(importers.length, 'the fixture path search found nothing, so this guard proves nothing');
  for (const path of importers) assert.match(path, /\.test\.tsx?$|test-support\//, `${path} reads the capture outside of tests`);
  assert.ok(!(await readFile(new URL('./index.ts', import.meta.url), 'utf8')).includes('fixtures'));
});
