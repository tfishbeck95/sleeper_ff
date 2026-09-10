import {
  KICKER_DISTANCE_BANDS, POINTS_ALLOWED_BOUNDS, POINTS_ALLOWED_BUCKETS, YARDS_ALLOWED_BOUNDS, YARDS_ALLOWED_BUCKETS,
  type DefenseForecast, type KickerDistanceBand, type KickerForecast, type PointsAllowedBucket, type YardsAllowedBucket,
} from '@sleeper/domain';
import type { ProviderDefenseLine, ProviderKickerLine } from './provider.js';

/**
 * Fields Sleeper's contracts require and no projection source publishes.
 *
 * Two gaps are structural rather than incidental. Sources publish a single 50-plus field-goal figure
 * because that is how the kicking game is usually summarized, while Sleeper pays `fgm_50_59` and
 * `fgm_60p` at different rates. And sources publish a *mean* points-allowed figure, while Sleeper's
 * tier bonuses are only meaningful as probabilities — a defense projected to allow 17 has not earned
 * the shutout bonus, it has some chance at it.
 *
 * Bridging those gaps is modelling, so every value produced here carries a `DerivationNote` naming
 * the method and its empirical basis. The notes travel in the ingestion report, never inside the
 * forecast objects: the position contracts reject unknown fields, and more importantly a derived
 * distribution must not be able to masquerade as a source-supplied one further downstream.
 */

/** One derived value, its method, and the observation base behind it. */
export interface DerivationNote { field: string; method: string; basis: string; explanation: string; }

/**
 * Empirical constants, isolated so they can be re-estimated from a later observation window without
 * touching the derivation logic. Recomputed from nflverse play-by-play, which is CC BY 4.0.
 */
export interface EmpiricalBasis {
  label: string;
  /** Share of 50-plus field-goal attempts struck from 50-59 yards; the remainder is 60-plus. */
  longAttemptShare5059: number;
  /** Make rates by long band, used only to split a supplied make total between the two. */
  makeRate5059: number;
  makeRate60p: number;
  /** Standard deviation of a team's points allowed in one game, as a function of the projected mean. */
  pointsAllowedSigma(mean: number): number;
  /** Standard deviation of a team's yards allowed in one game, as a function of the projected mean. */
  yardsAllowedSigma(mean: number): number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const NFLVERSE_BASIS: EmpiricalBasis = Object.freeze({
  label: 'nflverse play-by-play, 2019-2025 regular seasons (CC BY 4.0)',
  longAttemptShare5059: 0.9,
  makeRate5059: 0.66,
  makeRate60p: 0.4,
  // Game-level dispersion barely narrows for good defenses and widens for bad ones, so the spread is
  // anchored to a floor and scaled gently rather than treated as proportional to the mean.
  pointsAllowedSigma: (mean: number) => clamp(0.33 * mean + 2.8, 3.5, 12),
  yardsAllowedSigma: (mean: number) => clamp(0.25 * mean, 45, 120),
});

/** Abramowitz & Stegun 7.1.26; accurate to ~1.5e-7, far inside the 1e-6 tolerance the contracts use. */
function erf(x: number): number {
  const sign = Math.sign(x); const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return sign * y;
}
const normalCdf = (x: number, mean: number, sigma: number) => 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));

/**
 * Probability of each tier under a continuity-corrected normal centred on the projected mean.
 *
 * The lowest tier absorbs everything below it and the highest everything above, so no probability
 * mass is lost to impossible negative outcomes, and the result is renormalized so the contract's
 * "these probabilities describe one game" check holds exactly rather than approximately.
 */
export function tierProbabilities<Bucket extends string>(
  mean: number, sigma: number, buckets: readonly Bucket[], bounds: Readonly<Record<Bucket, readonly [number, number]>>,
): Record<Bucket, number> {
  const raw = buckets.map((bucket, index) => {
    const [low, high] = bounds[bucket];
    const lower = index === 0 ? -Infinity : low - 0.5;
    const upper = index === buckets.length - 1 ? Infinity : high + 0.5;
    return Math.max(0, normalCdf(upper, mean, sigma) - normalCdf(lower, mean, sigma));
  });
  const total = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map(value => (total > 0 ? value / total : 0));
  // Renormalization leaves a float residue; parking it on the modal tier keeps the sum exact without
  // perturbing a tier whose probability is meaningfully small.
  const modal = scaled.reduce((best, value, index) => (value > scaled[best] ? index : best), 0);
  scaled[modal] += 1 - scaled.reduce((a, b) => a + b, 0);
  return Object.fromEntries(buckets.map((bucket, index) => [bucket, scaled[index]])) as Record<Bucket, number>;
}

/**
 * Splits a source's combined 50-plus band into Sleeper's two.
 *
 * Makes are apportioned by each band's *expected* makes rather than by attempts, because a 60-yard
 * attempt converts far less often than a 52-yard one; splitting by attempts would quietly credit the
 * long band with accuracy it does not have. Both bands are then clamped so makes can never exceed
 * attempts, and any make displaced by that clamp moves to the other band rather than disappearing.
 */
export function splitLongBand(attempts: number, makes: number, basis: EmpiricalBasis): Record<'50_59' | '60p', { attempts: number; makes: number }> {
  const attempts5059 = attempts * basis.longAttemptShare5059;
  const attempts60p = attempts - attempts5059;
  const weight5059 = attempts5059 * basis.makeRate5059;
  const weight60p = attempts60p * basis.makeRate60p;
  const total = weight5059 + weight60p;
  let makes5059 = total > 0 ? makes * (weight5059 / total) : 0;
  let makes60p = makes - makes5059;
  if (makes5059 > attempts5059) { makes60p += makes5059 - attempts5059; makes5059 = attempts5059; }
  if (makes60p > attempts60p) { makes5059 = Math.min(attempts5059, makes5059 + (makes60p - attempts60p)); makes60p = attempts60p; }
  return { '50_59': { attempts: attempts5059, makes: makes5059 }, '60p': { attempts: attempts60p, makes: makes60p } };
}

export interface Derived<T> { value: T; notes: DerivationNote[] }

/** Turns a source's kicker line into the six-band contract, deriving only the long split. */
export function deriveKickerForecast(line: ProviderKickerLine, basis: EmpiricalBasis = NFLVERSE_BASIS): Derived<KickerForecast> {
  const notes: DerivationNote[] = [];
  const long = splitLongBand(line.fieldGoals['50p'].attempts, line.fieldGoals['50p'].makes, basis);
  notes.push({
    field: 'kicker.fieldGoals.50_59/60p',
    method: `empirical long-band split (${(basis.longAttemptShare5059 * 100).toFixed(0)}% of 50+ attempts from 50-59), makes apportioned by expected makes`,
    basis: basis.label,
    explanation: `The source publishes one 50-plus band; Sleeper scores fgm_50_59 and fgm_60p at different rates, so ${line.fieldGoals['50p'].attempts.toFixed(2)} long attempts were split into ${long['50_59'].attempts.toFixed(2)} and ${long['60p'].attempts.toFixed(2)}.`,
  });

  const fieldGoals = Object.fromEntries(KICKER_DISTANCE_BANDS.map(band => [
    band, band === '50_59' || band === '60p' ? long[band] : line.fieldGoals[band],
  ])) as KickerForecast['fieldGoals'];

  const longAttempts = long['50_59'].attempts + long['60p'].attempts;
  let longAttemptProbability = line.longAttemptProbability;
  if (longAttemptProbability === undefined) {
    // "At least one 50+ attempt", not the share of attempts: a Poisson arrival with the expected
    // long-attempt count as its rate is the least-assuming way to get one from the other.
    longAttemptProbability = 1 - Math.exp(-longAttempts);
    notes.push({
      field: 'kicker.longAttemptProbability', method: 'Poisson P(at least one) = 1 - exp(-expected long attempts)', basis: basis.label,
      explanation: `The source publishes expected 50-plus attempts but not the probability of taking one; ${longAttempts.toFixed(2)} expected attempts implies ${(longAttemptProbability * 100).toFixed(1)}%.`,
    });
  }

  const misses = KICKER_DISTANCE_BANDS.reduce((sum, band) => sum + (fieldGoals[band].attempts - fieldGoals[band].makes), 0);
  return {
    value: {
      fieldGoals, pat: { ...line.pat },
      // The contract requires the total to equal attempts minus makes exactly. Recomputing it from the
      // split bands keeps that identity true; carrying the source's own total across the split would
      // not, because the split is what changed the arithmetic.
      misses: { semantics: 'all-attempts-including-blocks', total: misses },
      longAttemptProbability: clamp(longAttemptProbability, longAttempts > 0 ? 1e-6 : 0, 1),
    },
    notes,
  };
}

/** Turns a source's defense line into the contract's complete tier distributions. */
export function deriveDefenseForecast(line: ProviderDefenseLine, basis: EmpiricalBasis = NFLVERSE_BASIS): Derived<DefenseForecast> {
  const notes: DerivationNote[] = [];
  const build = <Bucket extends string>(
    supplied: Record<Bucket, number> | undefined, mean: number, sigma: number,
    buckets: readonly Bucket[], bounds: Readonly<Record<Bucket, readonly [number, number]>>, what: string,
  ) => {
    if (supplied) return supplied;
    notes.push({
      field: `defense.${what}`, method: `continuity-corrected normal over Sleeper tiers, mean ${mean.toFixed(1)}, sigma ${sigma.toFixed(1)}`, basis: basis.label,
      explanation: `The source publishes a mean ${what.replace(/([A-Z])/g, ' $1').toLowerCase()} figure, not a distribution. Sleeper prices each tier bonus at its probability, so the mean was spread across the tiers rather than assigned to the one it lands in.`,
    });
    return tierProbabilities(mean, sigma, buckets, bounds);
  };

  const points = build(line.pointsAllowedDistribution, line.pointsAllowed, basis.pointsAllowedSigma(line.pointsAllowed), POINTS_ALLOWED_BUCKETS, POINTS_ALLOWED_BOUNDS, 'pointsAllowed');
  const yards = build(line.yardsAllowedDistribution, line.yardsAllowed, basis.yardsAllowedSigma(line.yardsAllowed), YARDS_ALLOWED_BUCKETS, YARDS_ALLOWED_BOUNDS, 'yardsAllowed');

  /** A mean the tiers cannot reach is dropped rather than emitted; the tiers alone still score. */
  const reachable = <Bucket extends string>(mean: number, table: Record<Bucket, number>, buckets: readonly Bucket[], bounds: Readonly<Record<Bucket, readonly [number, number]>>) => {
    const low = buckets.reduce((sum, bucket) => sum + table[bucket] * bounds[bucket][0], 0);
    const open = table[buckets[buckets.length - 1]] > 0;
    const high = open ? Infinity : buckets.reduce((sum, bucket) => sum + table[bucket] * bounds[bucket][1], 0);
    return mean >= low - 1e-6 && mean <= high + 1e-6;
  };

  return {
    value: {
      sacks: line.sacks, interceptions: line.interceptions, forcedFumbles: line.forcedFumbles,
      fumbleRecoveries: line.fumbleRecoveries, safeties: line.safeties, blockedKicks: line.blockedKicks,
      defensiveTouchdowns: line.defensiveTouchdowns,
      pointsAllowed: { buckets: points, ...(reachable(line.pointsAllowed, points, POINTS_ALLOWED_BUCKETS, POINTS_ALLOWED_BOUNDS) ? { expected: line.pointsAllowed } : {}) },
      yardsAllowed: { buckets: yards, ...(reachable(line.yardsAllowed, yards, YARDS_ALLOWED_BUCKETS, YARDS_ALLOWED_BOUNDS) ? { expected: line.yardsAllowed } : {}) },
      ...(line.specialTeams ? { specialTeams: { ...line.specialTeams } } : {}),
    } satisfies DefenseForecast,
    notes,
  };
}

export type { KickerDistanceBand, PointsAllowedBucket, YardsAllowedBucket };
