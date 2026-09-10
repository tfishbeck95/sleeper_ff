import assert from 'node:assert/strict';
import test from 'node:test';
import { KICKER_DISTANCE_BANDS, POINTS_ALLOWED_BOUNDS, POINTS_ALLOWED_BUCKETS, YARDS_ALLOWED_BUCKETS, YARDS_ALLOWED_BOUNDS } from '@sleeper/domain';
import { validateDefenseForecast } from '../defense.js';
import { validateKickerForecast } from '../kicker.js';
import { deriveDefenseForecast, deriveKickerForecast, NFLVERSE_BASIS, splitLongBand, tierProbabilities } from './derivation.js';
import type { ProviderDefenseLine, ProviderKickerLine } from './provider.js';

const kickerLine = (overrides: Partial<ProviderKickerLine> = {}): ProviderKickerLine => ({
  fieldGoals: { '0_19': { attempts: 0.1, makes: 0.1 }, '20_29': { attempts: 0.5, makes: 0.48 }, '30_39': { attempts: 0.7, makes: 0.64 }, '40_49': { attempts: 0.6, makes: 0.5 }, '50p': { attempts: 0.4, makes: 0.25 } },
  pat: { makes: 2.4, misses: 0.1 }, misses: 0.83, ...overrides,
});
const defenseLine = (overrides: Partial<ProviderDefenseLine> = {}): ProviderDefenseLine => ({
  sacks: 2.4, interceptions: 0.8, forcedFumbles: 0.7, fumbleRecoveries: 0.5, safeties: 0.05,
  blockedKicks: 0.06, defensiveTouchdowns: 0.15, pointsAllowed: 21.3, yardsAllowed: 341, ...overrides,
});

test('a derived kicker forecast satisfies the six-band contract the scoring boundary enforces', () => {
  const { value, notes } = deriveKickerForecast(kickerLine());
  assert.doesNotThrow(() => validateKickerForecast(value));
  assert.deepEqual(Object.keys(value.fieldGoals).sort(), [...KICKER_DISTANCE_BANDS].sort());
  assert.ok(notes.some(note => note.field === 'kicker.fieldGoals.50_59/60p'));
  assert.ok(notes.every(note => note.basis === NFLVERSE_BASIS.label));
});

test('splitting the long band preserves the source total and never makes more than it attempts', () => {
  for (const [attempts, makes] of [[0.4, 0.25], [2, 2], [0, 0], [1.5, 0.9], [3, 0]] as const) {
    const split = splitLongBand(attempts, makes, NFLVERSE_BASIS);
    const totalAttempts = split['50_59'].attempts + split['60p'].attempts;
    const totalMakes = split['50_59'].makes + split['60p'].makes;
    assert.ok(Math.abs(totalAttempts - attempts) < 1e-9, `attempts preserved for ${attempts}`);
    assert.ok(Math.abs(totalMakes - makes) < 1e-9, `makes preserved for ${attempts}/${makes}`);
    for (const band of ['50_59', '60p'] as const) assert.ok(split[band].makes <= split[band].attempts + 1e-9, `${band} makes within attempts`);
  }
});

test('the long band splits toward 50-59, where the attempts and the accuracy actually are', () => {
  const split = splitLongBand(1, 0.6, NFLVERSE_BASIS);
  assert.ok(split['50_59'].attempts > split['60p'].attempts);
  const accuracy = (band: '50_59' | '60p') => split[band].makes / split[band].attempts;
  assert.ok(accuracy('50_59') > accuracy('60p'), 'the shorter band converts more often');
});

test('long-attempt probability is derived as P(at least one), not as a share of attempts', () => {
  const { value } = deriveKickerForecast(kickerLine());
  assert.ok(value.longAttemptProbability > 0 && value.longAttemptProbability < 1);
  assert.ok(Math.abs(value.longAttemptProbability - (1 - Math.exp(-0.4))) < 1e-9);
  // A kicker with no long attempts must not be credited with a chance of one.
  const none = deriveKickerForecast(kickerLine({ fieldGoals: { ...kickerLine().fieldGoals, '50p': { attempts: 0, makes: 0 } }, misses: 0.43 }));
  assert.equal(none.value.longAttemptProbability, 0);
  assert.doesNotThrow(() => validateKickerForecast(none.value));
});

test('a supplied long-attempt probability is used instead of being derived over the top of it', () => {
  const { value, notes } = deriveKickerForecast(kickerLine({ longAttemptProbability: 0.31 }));
  assert.equal(value.longAttemptProbability, 0.31);
  assert.equal(notes.filter(note => note.field === 'kicker.longAttemptProbability').length, 0);
});

test('a derived defense forecast satisfies the tier-distribution contract', () => {
  const { value, notes } = deriveDefenseForecast(defenseLine());
  assert.doesNotThrow(() => validateDefenseForecast(value));
  assert.equal(value.pointsAllowed.expected, 21.3);
  assert.equal(value.yardsAllowed.expected, 341);
  assert.deepEqual(notes.map(note => note.field).sort(), ['defense.pointsAllowed', 'defense.yardsAllowed']);
});

test('tier probabilities are complete and sum to exactly one for any mean', () => {
  for (const mean of [0, 3, 10, 17, 21.3, 28, 42]) {
    const table = tierProbabilities(mean, NFLVERSE_BASIS.pointsAllowedSigma(mean), POINTS_ALLOWED_BUCKETS, POINTS_ALLOWED_BOUNDS);
    assert.deepEqual(Object.keys(table).sort(), [...POINTS_ALLOWED_BUCKETS].sort());
    const total = Object.values(table).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) <= 1e-9, `mean ${mean} sums to ${total}`);
    assert.ok(Object.values(table).every(value => value >= 0 && value <= 1));
  }
  for (const mean of [80, 250, 341, 480, 600]) {
    const table = tierProbabilities(mean, NFLVERSE_BASIS.yardsAllowedSigma(mean), YARDS_ALLOWED_BUCKETS, YARDS_ALLOWED_BOUNDS);
    assert.ok(Math.abs(Object.values(table).reduce((a, b) => a + b, 0) - 1) <= 1e-9);
  }
});

test('a favourable projection raises the chance of a shutout without ever granting the bonus', () => {
  const strong = deriveDefenseForecast(defenseLine({ pointsAllowed: 12 })).value;
  const weak = deriveDefenseForecast(defenseLine({ pointsAllowed: 28 })).value;
  assert.ok(strong.pointsAllowed.buckets['0'] > weak.pointsAllowed.buckets['0'], 'a better matchup raises P(shutout)');
  assert.ok(strong.pointsAllowed.buckets['0'] < 0.25, 'no projection ever asserts a shutout is likely');
  assert.ok(weak.pointsAllowed.buckets['28_34'] > strong.pointsAllowed.buckets['28_34']);
});

test('a source that already publishes distributions is passed through, not re-derived', () => {
  const buckets = { '0': 0.02, '1_6': 0.08, '7_13': 0.2, '14_20': 0.3, '21_27': 0.24, '28_34': 0.12, '35p': 0.04 };
  const { value, notes } = deriveDefenseForecast(defenseLine({ pointsAllowedDistribution: buckets }));
  assert.deepEqual(value.pointsAllowed.buckets, buckets);
  assert.deepEqual(notes.map(note => note.field), ['defense.yardsAllowed']);
  assert.doesNotThrow(() => validateDefenseForecast(value));
});

test('the unit\'s own return events are carried across, and never as individual st_* counts', () => {
  const { value } = deriveDefenseForecast(defenseLine({ specialTeams: { touchdowns: 0.05, forcedFumbles: 0.1, fumbleRecoveries: 0.08 } }));
  assert.deepEqual(value.specialTeams, { touchdowns: 0.05, forcedFumbles: 0.1, fumbleRecoveries: 0.08 });
  assert.doesNotThrow(() => validateDefenseForecast(value));
});
