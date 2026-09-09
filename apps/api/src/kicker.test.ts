import assert from 'node:assert/strict';
import test from 'node:test';
import { KICKER_DISTANCE_BANDS as BANDS, EXPECTED_SCORING, interpretScoring, type KickerForecast, type ScoringConfiguration } from '@sleeper/domain';
import { normalizeKickerStats, scoreKicker, kickerStreamerProfile, validateKickerForecast } from './kicker.js';
import { scoreLeagueForecasts, weekPoints } from './projection-scoring.js';
import { parseWaiverSignals } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './test-support/scoring-fixtures.js';

const now = new Date('2026-09-08T12:00:00Z');
const rules = (rates = {}) => interpretScoring([], { kind: 'complete-live', settings: { ...EXPECTED_SCORING, ...rates }, rawSettings: {}, synchronizedAt: now.toISOString(), issues: [] } as ScoringConfiguration);
const forecast = (): KickerForecast => ({
  fieldGoals: Object.fromEntries(BANDS.map(b => [b, { attempts: .5, makes: .4 }])) as KickerForecast['fieldGoals'],
  pat: { makes: 2, misses: .1 }, misses: { semantics: 'all-attempts-including-blocks', total: .6 }, longAttemptProbability: .6,
  context: { includedInForecast: false, offense: { drivesPerGame: 10, scoringDriveRate: .4 }, opponent: { redZoneTouchdownRate: .6 }, stadium: { name: 'Test field', roof: 'outdoor' }, weather: { windMph: 5, precipitationProbability: 0, temperatureF: 70 } },
});
const score = (f = forecast(), rates = {}, stats = {}) => { const r = rules(rates); return scoreKicker(r, normalizeKickerStats(r, stats, f), f); };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('all six kicker bands and PATs score from the live map with expected miss downside', () => {
  const s = score();
  near(s.points, 10.9); // .4*(3+3+3+4+5+6) + 2 - .1 - .6
  near(s.kicker!.missDownside, .7);
  near(s.kicker!.expectedAttempts, 3); near(s.kicker!.accuracy!, .8);
  assert.equal(s.kicker!.distances.length, 6);
  near(s.kicker!.distances[5].makePoints, 2.4);
  const changed = score(forecast(), { fgm_60p: 12, fgmiss: -3, xpmiss: -2 });
  near(changed.points, 12); near(changed.kicker!.missDownside, 2);
  near(changed.kicker!.fieldGoalMissPoints, -1.8);
});

test('aggregate plus category provider misses reconcile without doubling counts', () => {
  const f = forecast();
  f.misses.byDistance = Object.fromEntries(BANDS.map(b => [b, .1])) as NonNullable<KickerForecast['misses']['byDistance']>;
  const redundant = { fgmiss: .6, fgmiss_50p: .2, fgmiss_50_59: .1, fgmiss_60p: .1, fgm: 2.4, fgm_50p: .8, xpm: 2 };
  assert.equal(score(f).points, score(f, {}, redundant).points);
  delete f.misses.total;
  assert.equal(score(f).points, 10.9);
  // Two distinct active league keys intentionally stack; the aggregate is still .6, never 1.2.
  const custom = score(f, { fgmiss_50p: -2, fgmiss_60p: -3, fgmiss_50_59: -4 }, redundant);
  near(custom.kicker!.fieldGoalMissPoints, -1.7);
  near(custom.points, 9.8);
  assert.equal(custom.contributions.filter(c => c.stat === 'fgmiss').length, 1);
  near(custom.contributions.find(c => c.stat === 'fgmiss')!.amount, .6);
  assert.throws(() => score(f, {}, { fgmiss: 1.2 }), /conflicts/);
});

test('live category-only miss rules and aggregate/overlapping make rules remain independent', () => {
  const s = score(forecast(), { fgmiss: 0, fgmiss_50_59: -2, fgmiss_60p: -5, fgm: 1, fgm_50p: 2 });
  near(s.kicker!.fieldGoalMissPoints, -.7);
  near(s.kicker!.distances[5].missPoints, -.5);
  near(s.points, 14.8);
  const noMissCost = score(forecast(), { fgmiss: 0, xpmiss: 0 });
  assert.equal(noMissCost.kicker!.missDownside, 0);
  assert.throws(() => score(forecast(), { fgm_yds: .1 }), /requires projected made-kick yardage/);
  near(score(forecast(), { fgm_yds: .1 }, { fgm_yds: 100 }).points, 20.9);
});

function input() {
  const value = demoWaiverInput(now);
  value.league.rosterPositions = ['K', 'BN', 'BN', 'BN', 'BN', 'BN'].map((position, slot) => ({ position, slot }));
  value.rosters[0].starterIds = ['starter-rb'];
  for (const p of value.players) { p.position = 'K'; p.fantasyPositions = ['K']; p.injuryStatus = null; }
  for (const s of value.signals!.players) {
    s.role = undefined; s.recentTargets = undefined; s.dynastyStats = {}; s.dynastyKicker = forecast();
    s.weeks = s.weeks.map(w => ({ week: w.week, bye: false, opponent: 'TEST', stats: {}, kicker: forecast() }));
  }
  return value;
}
const boundary = (value: ReturnType<typeof input>) => scoreLeagueForecasts({ rules: rules(), signals: value.signals!, players: value.players, availability: { policy: 'selected-week', selectedWeek: 8 } });

test('adapter and direct boundary refuse incomplete, inconsistent or pre-scored kicker forecasts', () => {
  const mutations: Array<(f: KickerForecast) => void> = [
    f => { delete (f.fieldGoals as Partial<KickerForecast['fieldGoals']>)['60p']; },
    f => { f.fieldGoals['40_49'].makes = 2; },
    f => { f.fieldGoals['20_29'].attempts = -1; },
    f => { f.pat.misses = NaN; },
    f => { f.misses.semantics = 'category-only' as never; },
    f => { f.misses.total = 9; },
    f => { f.longAttemptProbability = 1.1; },
    f => { (f as unknown as Record<string, unknown>).points = 12; },
    f => { f.context!.game = { licensed: false, source: 'Unlicensed', impliedTeamPoints: 27, spread: -3 } as never; },
    f => { f.context!.weather!.precipitationProbability = 80; },
    f => { f.context!.offense!.scoringDriveRate = Infinity; },
  ];
  for (const mutate of mutations) {
    const value = input(); mutate(value.signals!.players[0].weeks[0].kicker!);
    assert.throws(() => parseWaiverSignals(value.signals));
    assert.ok(boundary(value).rejected.some(r => r.playerId === value.signals!.players[0].playerId));
  }
  const value = input(); const w = value.signals!.players[0].weeks[0];
  delete w.kicker; w.stats = { fgm: 3, xpm: 2 };
  assert.match(boundary(value).rejected[0].message, /all six distance categories/);
  w.kicker = forecast(); w.stats = { projectedPoints: 12 };
  assert.equal(boundary(value).rejected[0].kind, 'pre-scored');
  w.stats = {}; w.matchupMultiplier = 1.1;
  assert.match(boundary(value).rejected[0].message, /multipliers/);
});

test('zero attempts are explicit, and long probability is not inferred from an attempt share', () => {
  const f = forecast();
  for (const b of BANDS) f.fieldGoals[b] = { attempts: 0, makes: 0 };
  f.misses.total = 0; f.longAttemptProbability = 0;
  validateKickerForecast(f); assert.equal(score(f).kicker!.accuracy, null);
  f.longAttemptProbability = .2; assert.throws(() => validateKickerForecast(f), /probability/);
  f.longAttemptProbability = 0; f.fieldGoals['60p'].attempts = .1; f.misses.total = .1;
  assert.throws(() => validateKickerForecast(f), /probability/);
});

test('scenarios and dynasty require the same detailed contract; scoring does not mutate provider stats', () => {
  const value = input(); const s = value.signals!.players[0]; const w = s.weeks[0];
  w.floorStats = {}; w.floorKicker = forecast(); w.floorKicker.pat.makes = 0;
  w.ceilingStats = {}; w.ceilingKicker = forecast(); w.ceilingKicker.pat.makes = 5;
  parseWaiverSignals(value.signals);
  const saved = structuredClone(value.signals);
  const p = boundary(value).players[0];
  assert.equal(p.weeks[0].floor!.points, 8.9); assert.equal(p.weeks[0].ceiling!.points, 13.9);
  assert.equal(p.dynasty!.kicker!.expectedPoints, 10.9);
  assert.deepEqual(value.signals, saved);
  w.floorKicker.pat.makes = 20;
  assert.equal(boundary(value).players[0].weeks[0].floor, null);
  delete w.floorKicker;
  assert.ok(boundary(value).rejected.length);
});

test('byes and unavailable kickers zero expected points and monetary miss exposure', () => {
  const value = input(); const w = value.signals!.players[0].weeks[0]; w.bye = true;
  let scored = weekPoints(rules(), boundary(value).players[0].weeks[0]);
  assert.equal(scored.points, 0); assert.equal(scored.kicker!.missDownside, 0);
  assert.ok(scored.kicker!.distances.every(d => d.missPoints === 0 && d.makePoints === 0));
  w.bye = false; value.signals!.players[0].injuryStatus = 'Out';
  scored = weekPoints(rules(), boundary(value).players[0].weeks[0]);
  assert.equal(scored.points, 0);
});

test('streamer factors use workload, accuracy, drives, red zone, weather and licensed game environment', () => {
  const f = forecast();
  const profile = () => kickerStreamerProfile(score(f).kicker!);
  const base = profile();
  f.context!.offense = { drivesPerGame: 12, scoringDriveRate: .6 };
  assert.ok(profile().rankingAdjustment > base.rankingAdjustment);
  f.context!.opponent!.redZoneTouchdownRate = .3;
  assert.ok(profile().rankingAdjustment > base.rankingAdjustment);
  const fair = profile().rankingAdjustment;
  f.context!.weather = { windMph: 30, precipitationProbability: 1, temperatureF: 0 };
  assert.ok(profile().rankingAdjustment < fair);
  f.context!.stadium!.roof = 'retractable-closed';
  near(profile().rankingAdjustment, fair);
  f.context!.game = { licensed: true, source: 'Licensed test feed', impliedTeamPoints: 30, spread: -7 };
  assert.ok(profile().rankingAdjustment > fair);
  f.context!.includedInForecast = true;
  assert.ok(profile().factors.filter(v => ['Offensive drive quality', 'Opponent red zone', 'Stadium and weather', 'Game script', 'Implied scoring environment'].includes(v.label)).every(v => v.value === 0));
  assert.equal(score(f).points, 10.9, 'context preferences never rewrite projected points');
  delete f.context;
  assert.equal(profile().missingContext.length, 4);
  assert.equal(profile().factors.some(v => v.label === 'Game script'), false);
});

test('waiver streamers expose downside and change priority with forecasts and context, independent of reputation', () => {
  const value = input();
  // Leave space for additions; compare against an empty K slot.
  value.rosters[0].starterIds = ['0'];
  value.rosters[0].playerIds = []; value.rosters[0].reserveIds = []; value.rosters[0].taxiIds = [];
  const candidate = value.signals!.players.find(s => s.playerId === 'add-rb')!;
  const row = () => recommendWaivers(value).recommendations.find(r => r.add.id === candidate.playerId && r.horizon === 'streamer')!;
  const baseline = row(); assert.ok(baseline); assert.equal(baseline.projectedPoints, 10.9);
  near(baseline.kicker!.forecast.missDownside, .7);
  candidate.weeks[0].kicker!.context!.weather = { windMph: 30, precipitationProbability: 1, temperatureF: 0 };
  assert.ok(row().score < baseline.score);
  const weatherScore = row().score;
  const player = value.players.find(p => p.id === candidate.playerId)!; player.fullName = 'Famous team kicker'; player.team = 'KC';
  assert.equal(row().score, weatherScore);
  for (const w of candidate.weeks) { w.kicker!.fieldGoals['60p'] = { attempts: 1, makes: .9 }; }
  assert.ok(row().projectedPoints > baseline.projectedPoints);
  delete candidate.weeks[0].kicker;
  assert.equal(row(), undefined);
});

test('accuracy and long-distance preferences respond to their own forecasts; miss downside uses league rates', () => {
  const f = forecast();
  const base = kickerStreamerProfile(score(f).kicker!);
  f.longAttemptProbability = .9;
  const longer = kickerStreamerProfile(score(f).kicker!);
  assert.ok(longer.rankingAdjustment > base.rankingAdjustment);
  assert.equal(longer.forecast.expectedPoints, base.forecast.expectedPoints);
  f.fieldGoals['60p'].makes = .1; f.misses.total = .9;
  const inaccurate = kickerStreamerProfile(score(f).kicker!);
  assert.ok(inaccurate.forecast.missDownside > longer.forecast.missDownside);
  assert.ok(inaccurate.rankingAdjustment < longer.rankingAdjustment);
  assert.ok(inaccurate.forecast.expectedPoints < longer.forecast.expectedPoints);
  assert.ok(kickerStreamerProfile(score(f, { fgmiss: -4 }).kicker!).rankingAdjustment < inaccurate.rankingAdjustment);
});

test('live scoring can reverse streamer priorities and receiving metadata cannot sway kicker ranking', () => {
  const value = input();
  value.rosters[0].starterIds = ['0']; value.rosters[0].playerIds = []; value.rosters[0].reserveIds = []; value.rosters[0].taxiIds = [];
  const short = value.signals!.players.find(s => s.playerId === 'add-rb')!;
  const long = value.signals!.players.find(s => s.playerId === 'add-wr')!;
  for (const s of [short, long]) for (const w of s.weeks) {
    const k = w.kicker!;
    for (const b of BANDS) k.fieldGoals[b] = { attempts: 0, makes: 0 };
    k.fieldGoals[s === short ? '20_29' : '60p'] = { attempts: 2, makes: 2 };
    k.misses.total = 0; k.longAttemptProbability = s === short ? 0 : 1;
  }
  const rows = () => recommendWaivers(value).recommendations.filter(r => r.horizon === 'streamer');
  const find = (id: string) => rows().find(r => r.add.id === id)!;
  assert.ok(find(long.playerId).score > find(short.playerId).score);
  value.league.scoring = rules({ fgm_20_29: 8, fgm_60p: 2 }).configuration;
  assert.ok(find(long.playerId).score < find(short.playerId).score);
  const baseline = find(short.playerId).score;
  short.recentTargets = [1, 2, 10, 20, 25, 30];
  short.weeks[0].opportunity = { targets: 20, routes: 30, targetShare: .9 };
  assert.equal(find(short.playerId).score, baseline);
  assert.equal(find(short.playerId).opportunity, null);
});
