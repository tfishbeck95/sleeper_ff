import { EXPECTED_SCORING, liveScoring, scoringSnapshotId } from '@sleeper/domain';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ROLE_SCORE, recommendWaivers, roleScore, type WaiverInput } from './waivers.js';
import { demoWaiverInput } from './test-support/scoring-fixtures.js';
import { FileWaiverSignalProvider, parseWaiverSignals } from './waiver-signals.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = () => demoWaiverInput(new Date('2026-09-08T12:00:00Z'));
const signal = (input: WaiverInput, id: string) => input.signals!.players.find(p => p.playerId === id)!;
const rows = (input: WaiverInput, id: string) => recommendWaivers(input).recommendations.filter(r => r.add.id === id);

test('league membership includes reserve, taxi and starter-only records, without leaking other leagues', () => {
  const input = fixture();
  input.rosters[1].reserveIds = ['add-rb']; input.rosters[1].taxiIds = ['add-wr']; input.rosters[1].starterIds = ['add-te'];
  input.rosters.push({ ...input.rosters[1], id: 'other:1', leagueId: 'other', playerIds: ['stash'] });
  const result = recommendWaivers(input);
  assert.equal(result.rosteredCount, 9);
  assert.ok(result.recommendations.length);
  assert.ok(result.recommendations.every(r => r.add.id === 'stash'));
  input.rosters = [input.rosters[0]];
  assert.equal(recommendWaivers(input).status, 'unavailable');
});

test('acquisition restrictions, inactive league and invalid player positions remove candidates', () => {
  const input = fixture();
  signal(input, 'add-rb').acquisitionEligible = false;
  input.signals!.leagues = { demo: { blockedAddIds: ['add-wr'] } };
  input.players.find(p => p.id === 'add-te')!.fantasyPositions = ['QB'];
  assert.ok(recommendWaivers(input).recommendations.every(r => r.add.id === 'stash'));
  input.league.settings!.disable_adds = 1;
  assert.equal(recommendWaivers(input).recommendations.length, 0);
  input.league.settings!.disable_adds = 0; input.league.status = 'drafting';
  assert.equal(recommendWaivers(input).recommendations.length, 0);
});

test('custom scoring and eligible FLEX starters change player value and comparisons', () => {
  const input = fixture();
  input.league.rosterPositions[0].position = 'SUPER_FLEX';
  const before = rows(input, 'add-wr').find(r => r.horizon === 'streamer')!;
  assert.equal(before.starterComparison?.id, 'starter-rb');
  assert.equal(before.projectedPoints, 14);
  input.league.scoring = liveScoring({ ...EXPECTED_SCORING, bonus_rec_wr: 1 }, input.league.synchronizedAt);
  for (const player of input.signals!.players) for (const week of player.weeks) week.stats.bonus_rec_wr = week.stats.rec ?? 0;
  const after = rows(input, 'add-wr').find(r => r.horizon === 'streamer')!;
  assert.equal(after.projectedPoints, 21);
  assert.ok(after.score > before.score);
});

test('bye and injuries suppress streamers but allow justified season and dynasty stashes', () => {
  const input = fixture();
  signal(input, 'add-rb').weeks[0].bye = true;
  assert.ok(rows(input, 'add-rb').every(r => r.horizon !== 'streamer'));
  assert.ok(rows(input, 'add-rb').some(r => r.horizon === 'rest-of-season'));
  signal(input, 'stash').injuryStatus = 'IR';
  const stash = rows(input, 'stash');
  assert.ok(stash.some(r => r.horizon === 'dynasty' && r.risk === 'high'));
  assert.ok(stash.every(r => r.horizon !== 'streamer'));
  assert.equal(rows(input, 'add-te').find(r => r.horizon === 'streamer')!.need, 'bye-cover');
  signal(input, 'add-rb').weeks[0].bye = false;
  assert.equal(rows(input, 'add-rb').find(r => r.horizon === 'streamer')!.need, 'injury-cover');
});

test('opponents, role trends and playoff schedule affect forecasts and ordering', () => {
  const input = fixture();
  const before = rows(input, 'add-wr').find(r => r.horizon === 'rest-of-season')!;
  signal(input, 'add-wr').weeks.at(-1)!.matchupMultiplier = 1.5;
  const after = rows(input, 'add-wr').find(r => r.horizon === 'rest-of-season')!;
  assert.ok(after.projectedPoints > before.projectedPoints);
  assert.ok(after.playoffPoints! > before.playoffPoints!);
  signal(input, 'add-wr').role = { recentShare: .8, previousShare: .3, games: 1 };
  const trend = rows(input, 'add-wr').find(r => r.horizon === 'streamer')!;
  assert.equal(trend.projectedPoints, 16.1);
  assert.ok(trend.uncertainty.some(t => /only 1/.test(t)));
  assert.match(trend.reasons.join(' '), /adjustment 15%/);
  input.league.settings!.playoff_week_start = 7;
  assert.equal(recommendWaivers(input).status, 'unavailable');
});

test('drop selection protects starters, IR, taxi, explicit locks and dynasty retention', () => {
  const input = fixture();
  signal(input, 'bench-1').dynastyStats = { rush_yd: 300 };
  signal(input, 'bench-2').droppable = false;
  input.rosters[0].taxiIds = ['bench-3'];
  // Free active slot needs no drop; stored IR/taxi membership isn't extra active capacity.
  assert.ok(recommendWaivers(input).recommendations.every(r => r.drop === null));
  input.rosters[0].taxiIds = [];
  input.signals!.leagues = { demo: { protectedDropIds: ['bench-3'] } };
  assert.equal(recommendWaivers(input).recommendations.length, 0);
  delete input.signals!.leagues;
  const result = recommendWaivers(input);
  assert.ok(result.recommendations.length);
  assert.ok(result.recommendations.every(r => r.drop?.id === 'bench-3'));
});

test('full rosters require a legal safe drop; open slots need none; position caps apply after drop', () => {
  const input = fixture();
  input.signals!.leagues = { demo: { positionLimits: { RB: 2 } } };
  assert.ok(rows(input, 'add-rb').every(r => r.drop?.id === 'bench-1'));
  signal(input, 'bench-1').droppable = false;
  assert.equal(rows(input, 'add-rb').length, 0);
  input.rosters[0].playerIds = input.rosters[0].playerIds.filter(id => id !== 'bench-1');
  assert.ok(rows(input, 'add-rb').length);
  assert.ok(rows(input, 'add-rb').every(r => r.drop === null));
  input.rosters[0].playerIds.push('unknown-1', 'unknown-2');
  assert.equal(recommendWaivers(input).recommendations.length, 0);
});

test('unknown projections are never zero-value drop candidates or fabricated starter comparisons', () => {
  const input = fixture();
  input.signals!.players = input.signals!.players.filter(p => !['bench-1', 'bench-2', 'bench-3'].includes(p.playerId));
  assert.equal(recommendWaivers(input).recommendations.length, 0);
  const next = fixture();
  next.rosters[0].starterIds[1] = 'unknown-starter';
  next.rosters[0].playerIds = next.rosters[0].playerIds.filter(id => id !== 'starter-wr');
  const result = rows(next, 'add-wr');
  assert.ok(result.length);
  assert.ok(result.every(r => r.starterGain === null && r.horizon !== 'streamer'));
  assert.ok(result[0].uncertainty.some(s => /comparison is incomplete/.test(s)));
});

test('incomplete season forecasts suppress ROS and unsafe drops, while redraft omits dynasty', () => {
  const input = fixture();
  signal(input, 'add-wr').weeks.pop();
  assert.ok(rows(input, 'add-wr').every(r => r.horizon !== 'rest-of-season'));
  assert.ok(rows(input, 'add-wr').some(r => r.uncertainty.some(s => /incomplete/.test(s))));
  input.league.settings!.type = 0;
  assert.ok(recommendWaivers(input).recommendations.every(r => r.horizon !== 'dynasty'));
});

test('FAAB ranges use remaining budget, zero balance, missing balances and priority leagues', () => {
  const input = fixture();
  input.signals!.leagues = { demo: { faabRemaining: { '1': 3 } } };
  const report = recommendWaivers(input);
  assert.ok(report.recommendations.length);
  for (const r of report.recommendations) {
    assert.ok(r.faab); assert.ok(r.faab.min >= 0 && r.faab.min <= r.faab.max && r.faab.max <= 3);
    assert.match(r.faab.explanation, /urgency/); assert.match(r.faab.explanation, /unknown/);
  }
  input.signals!.leagues!.demo.faabRemaining!['1'] = 0;
  assert.ok(recommendWaivers(input).recommendations.every(r => r.faab?.min === 0 && r.faab.max === 0));
  delete input.signals!.leagues; delete input.rosters[0].settings.waiver_budget_used;
  assert.ok(recommendWaivers(input).recommendations.every(r => r.faab === null));
  input.league.settings!.waiver_type = 1;
  assert.ok(recommendWaivers(input).recommendations.every(r => r.faab === null));
});

test('source absence, mismatched season/week and stale timestamps fail closed', () => {
  const input = fixture();
  const original = input.signals!;
  for (const signals of [null, { ...original, season: '2025' }, { ...original, week: 9 }, { ...original, updatedAt: '2026-09-01T00:00:00Z' }, { ...original, updatedAt: '2027-01-01T00:00:00Z' }]) {
    const result = recommendWaivers({ ...input, signals });
    assert.equal(result.status, 'unavailable'); assert.equal(result.recommendations.length, 0);
  }
});

test('signal file validates duplicate, invalid and nonfinite forecasts and scopes season/week', async () => {
  const input = fixture().signals!;
  assert.equal(parseWaiverSignals(input).source, input.source);
  assert.throws(() => parseWaiverSignals({ ...input, players: [...input.players, input.players[0]] }));
  assert.throws(() => parseWaiverSignals({ ...input, players: [{ ...input.players[0], weeks: [{ week: 8, stats: { rec: NaN } }] }] }));
  assert.throws(() => parseWaiverSignals({ ...input, players: [{ ...input.players[0], role: { recentShare: 4, previousShare: 0, games: 2 } }] }));
  assert.throws(() => parseWaiverSignals({ ...input, leagues: { demo: { faabRemaining: { '1': -1 } } } }));
  const dir = await mkdtemp(join(tmpdir(), 'waiver-source-'));
  const path = join(dir, 'signals.json'); await writeFile(path, JSON.stringify(input));
  const provider = new FileWaiverSignalProvider(path);
  assert.ok(await provider.load('2026', 8));
  assert.equal(await provider.load('2026', 9), null);
  assert.equal(await provider.load('2025', 8), null);
});

test('drops preserve current and future starter coverage, including overlapping superflex eligibility', () => {
  const input = fixture();
  // The only RB backup must cover the injured starter, even though he is the cheapest drop.
  assert.ok(rows(input, 'add-wr').length);
  assert.ok(rows(input, 'add-wr').every(r => r.drop?.id !== 'bench-1'));
  input.players.find(p => p.id === 'starter-rb')!.injuryStatus = null;
  signal(input, 'starter-rb').weeks[1].bye = true;
  assert.ok(rows(input, 'add-wr').every(r => r.drop?.id !== 'bench-1'));
  // A multi-position incumbent can cover RB while the add fills SUPER_FLEX.
  input.league.rosterPositions[1].position = 'SUPER_FLEX';
  input.players.find(p => p.id === 'starter-wr')!.fantasyPositions = ['RB', 'WR'];
  assert.ok(rows(input, 'add-wr').some(r => r.drop?.id === 'bench-1'));
});

test('waiver rows carry the scoring snapshot, the league-scored sentence and the contributions', () => {
  const input = fixture();
  const report = recommendWaivers(input);
  assert.equal(report.scoringSnapshotId, scoringSnapshotId(input.league.scoring!));
  assert.equal(report.scoringLabel, 'full-PPR');
  assert.equal(report.forecastUpdatedAt, input.signals!.updatedAt);
  const row = report.recommendations.find(r => r.add.id === 'add-wr' && r.horizon === 'streamer')!;
  assert.equal(row.projectedPoints, 14);
  assert.equal(row.pointsExplanation, "14.0 points under your league's full-PPR scoring this week");
  assert.deepEqual(row.contributions.map(c => c.stat).sort(), ['rec', 'rec_yd']);
  assert.equal(row.contributions.reduce((sum, c) => sum + c.points, 0), 14);
  assert.ok(row.reasons.some(reason => /Your league's full-PPR scoring applied to the provider's raw stat forecast/.test(reason)));
  assert.ok(row.reasons.some(reason => /Week 8: 14\.0 points under your league's full-PPR scoring/.test(reason)));
});

test('a projection whose units or identity fail validation is refused, not ranked or zeroed', () => {
  const input = fixture();
  signal(input, 'add-wr').weeks.forEach(week => { week.stats = { targets: 9 }; });
  input.signals!.players.push({ playerId: 'phantom', weeks: signal(input, 'add-rb').weeks });
  const report = recommendWaivers(input);
  assert.deepEqual(report.rejected.map(r => r.kind).sort(), ['identity', 'units']);
  assert.match(report.rejected.find(r => r.kind === 'units')!.message, /this league's scoring rules do not define/);
  assert.deepEqual(report.recommendations.filter(r => r.add.id === 'add-wr'), [], 'a refused candidate is never ranked');
  assert.ok(report.warnings.some(w => /refused because their raw-stat units or player identity/.test(w)));
  assert.ok(report.recommendations.some(r => r.add.id === 'add-rb'), 'other validated candidates still rank');
});

test('a pre-scored fantasy total is refused rather than accepted as authoritative', () => {
  const input = fixture();
  signal(input, 'add-rb').weeks.forEach(week => { week.stats = { projectedPoints: 30 }; });
  const report = recommendWaivers(input);
  assert.equal(report.rejected[0].kind, 'pre-scored');
  assert.match(report.rejected[0].message, /Provide raw statistics; this league scores them/);
  assert.deepEqual(report.recommendations.filter(r => r.add.id === 'add-rb'), []);
});

test('a refused rostered projection is never treated as a zero-value drop or starter baseline', () => {
  const input = fixture();
  input.league.settings!.type = 0;
  const before = recommendWaivers(input);
  assert.ok(before.recommendations.some(r => r.drop?.id === 'bench-1'), 'the weakest bench player is normally the drop');
  // His forecast now fails unit validation. A bye must not turn the refusal into a zero-cost drop.
  signal(input, 'bench-1').weeks.forEach(week => { week.stats = { targets: 3 }; week.bye = true; });
  const report = recommendWaivers(input);
  assert.equal(report.rejected[0].kind, 'units');
  assert.ok(report.recommendations.length, 'other candidates still rank');
  assert.ok(report.recommendations.every(r => r.drop?.id !== 'bench-1'), 'a refused player is not a droppable baseline');
  assert.ok(report.recommendations.every(r => r.weakestBench?.id !== 'bench-1'));
});

test('season-long adds prefer a stable target share; streamers prefer target growth', () => {
  // One player, one variable: only the shape of his observed target series changes.
  const shaped = (recentTargets: number[]) => {
    const input = fixture();
    const s = signal(input, 'add-wr');
    s.role = { previousShare: .4, recentShare: .4, games: 4 };
    s.weeks.forEach(w => { w.opportunity = { targets: 9, routes: 32, routeParticipation: .9, targetShare: .22 }; });
    s.recentTargets = recentTargets;
    return recommendWaivers(input).recommendations.filter(r => r.add.id === 'add-wr');
  };
  const steady = shaped([9, 8, 10, 9, 9, 8]), climbing = shaped([2, 3, 4, 12, 14, 15]);
  const row = (rows: typeof steady, horizon: string) => rows.find(r => r.horizon === horizon)!;
  assert.equal(row(steady, 'streamer').projectedPoints, row(climbing, 'streamer').projectedPoints, 'the league-scored points are identical');
  assert.ok(row(steady, 'rest-of-season').score > row(climbing, 'rest-of-season').score, 'a season-long add prefers the stable target share');
  assert.ok(row(climbing, 'streamer').score > row(steady, 'streamer').score, 'a streamer prefers the climbing target share');
  assert.match(row(steady, 'rest-of-season').reasons.find(r => /prefer stable reception volume/.test(r))!, /target stability 0\.922 moves the ranking score \+1\.27, capped at 1\.5/);
  assert.match(row(climbing, 'streamer').reasons.find(r => /prefers target growth/.test(r))!, /moves the ranking score \+1\.5, capped at 1\.5/);
  // Whatever the series, the preference stays inside its documented bound.
  for (const rows of [steady, climbing]) for (const r of rows) assert.ok(Math.abs(roleScore(r.opportunity, r.horizon).value) <= MAX_ROLE_SCORE);
});

test('role signals move the ranking score only, never the league-scored points', () => {
  const plain = fixture(), enriched = fixture();
  for (const s of enriched.signals!.players) s.recentTargets = [9, 8, 10, 9, 9, 8];
  const before = recommendWaivers(plain).recommendations;
  const after = recommendWaivers(enriched).recommendations;
  for (const row of after) {
    const match = before.find(r => r.id === row.id);
    if (match) assert.equal(row.projectedPoints, match.projectedPoints, `${row.id} points must not move with a role signal`);
  }
});

test('a pass-catching back is named and its full-PPR premium quantified', () => {
  const row = recommendWaivers(fixture()).recommendations.find(r => r.add.id === 'stash')!;
  assert.equal(row.opportunity!.passCatchingBack, true);
  assert.equal(row.opportunity!.archetype, 'volume-driven');
  assert.ok(row.reasons.some(reason => /Pass-catching back/.test(reason)));
  assert.ok(row.reasons.some(reason => /Standard-scoring running-back rankings do not price those receptions/.test(reason)));
  assert.ok(row.reasons.some(reason => /Under non-PPR scoring the same stat line projects/.test(reason)));
});

test('touchdown dependence grades as uncertainty rather than as a hidden points penalty', () => {
  const input = fixture();
  const s = signal(input, 'add-wr');
  s.weeks.forEach(w => { w.stats = { rec: 2, rec_yd: 40, rec_td: 1.5 }; delete w.floorStats; delete w.ceilingStats; });
  const row = recommendWaivers(input).recommendations.find(r => r.add.id === 'add-wr' && r.horizon === 'streamer')!;
  assert.equal(row.opportunity!.archetype, 'touchdown-dependent');
  assert.equal(row.projectedPoints, 15, 'the points are exactly what the league scored: 2 + 4 + 9');
  assert.ok(row.uncertainty.some(value => /Touchdown-dependent/.test(value)));
});
