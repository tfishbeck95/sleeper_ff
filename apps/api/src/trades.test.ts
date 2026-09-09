import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretRoster, type TradeOffer } from '@sleeper/domain';
import { demoTradeInput } from './test-support/scoring-fixtures.js';
import { recommendTrades, parseTradeBounds, valueTradePlayer } from './trades.js';
import { optimizeTradeLineup } from './trade-lineup.js';
import { parseWaiverSignals } from './waiver-signals.js';

// A fixed clock keeps the scoring snapshot identity stable, so repeated runs are comparable.
const offers = () => recommendTrades(demoTradeInput(new Date('2026-09-08T12:00:00Z')));
test('bilateral needs, cheaper fallbacks, value bounds and legal before/after explanations', () => {
  const report = offers();
  assert.equal(report.status, 'ready'); assert.equal(report.teams.length, 2); assert.ok(report.candidates.length > 1);
  assert.ok(report.teams.every(t => t.surplus.length && t.needs.length));
  assert.equal(report.teams[0].strategy, report.teams[1].strategy, 'tied teams must not be classified by ID');
  const check = (o: TradeOffer) => {
    assert.ok(o.user.needImprovements.length); assert.ok(o.partner.needImprovements.length);
    assert.ok(o.user.after.legal && o.partner.after.legal);
    assert.ok(o.user.after.points >= o.user.before.points && o.partner.after.points >= o.partner.before.points);
    assert.ok(o.valueGap <= report.bounds.maxValueGap && o.risk <= report.bounds.maxRisk);
    assert.equal(new Set(o.give.concat(o.receive).map(a => a.id)).size, o.give.length + o.receive.length);
    assert.ok(o.whyAccept.length && o.risks.length);
    assert.doesNotMatch(o.whyAccept.join(' '), /likely to accept|acceptance probability/i);
  };
  report.candidates.forEach(c => { check(c); if (c.fallback) { check(c.fallback); assert.equal(c.fallback.partner.rosterId, c.partner.rosterId); assert.ok(c.fallback.user.valueDelivered < c.user.valueDelivered); } });
  assert.ok(report.candidates[0].fallback);
  assert.deepEqual(offers().candidates, report.candidates, 'search is deterministic');
});

test('exact optimizer preserves multi-position coverage and maximizes flex points', () => {
  const pool = [{ id: 'both', name: 'Both', positions: ['RB', 'WR'], points: 25 }, { id: 'rb', name: 'RB', positions: ['RB'], points: 20 }, { id: 'te', name: 'TE', positions: ['TE'], points: 15 }];
  const lineup = optimizeTradeLineup(pool, interpretRoster(['RB', 'WR', 'FLEX']));
  assert.equal(lineup.legal, true); assert.equal(lineup.points, 60);
  assert.deepEqual(lineup.slots.map(s => s.playerId), ['rb', 'both', 'te']);
  assert.equal(optimizeTradeLineup(pool.slice(1), interpretRoster(['RB', 'WR'])).legal, false);
  const superflex = optimizeTradeLineup([...pool, { id: 'q', name: 'QB', positions: ['QB'], points: 30 }], interpretRoster(['QB', 'SUPER_FLEX', 'FLEX']));
  assert.equal(superflex.points, 75); assert.equal(superflex.legal, true);
});

test('optimizer agrees with brute force on varied overlapping slots and negative projections', () => {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647);
  for (let sample = 0; sample < 30; sample++) {
    const rules = interpretRoster(['RB', 'WR', 'FLEX']);
    const pool = Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: String(i), positions: [['RB'], ['WR'], ['TE'], ['RB', 'WR']][next() % 4], points: next() % 35 - 10 }));
    let bestFilled = -1, bestPoints = -Infinity;
    const walk = (slot: number, used: Set<string>, filled: number, points: number) => {
      if (slot === 3) { if (filled > bestFilled || filled === bestFilled && points > bestPoints) { bestFilled = filled; bestPoints = points; } return; }
      walk(slot + 1, used, filled, points);
      for (const p of pool) if (!used.has(p.id) && p.positions.some(pos => rules.eligiblePositions(rules.starters[slot].position).includes(pos))) walk(slot + 1, new Set([...used, p.id]), filled + 1, points + p.points);
    };
    walk(0, new Set(), 0, 0);
    const result = optimizeTradeLineup(pool, rules);
    assert.equal(result.slots.filter(s => s.playerId !== null).length, bestFilled); assert.equal(result.points, bestPoints);
  }
});

test('rejects offers that leave a future bye hole, even when this week improves', () => {
  const input = demoTradeInput();
  for (const s of input.signals!.players.filter(p => ['o-depth', 'o-fallback'].includes(p.playerId))) s.weeks.find(w => w.week === 9)!.bye = true;
  const report = recommendTrades(input);
  assert.ok(report.candidates.every(c => !c.receive.some(a => a.id === 'o-rb')), 'other manager cannot trade only available week 9 RB');
  assert.ok(report.candidates.length, 'safe alternatives remain');
});

test('a matching value number alone never qualifies a trade without a partner need', () => {
  const input = demoTradeInput();
  input.signals!.players.forEach(s => { s.weeks.forEach(w => w.stats = { rush_yd: 150 }); });
  for (const [id, position] of [['u-fallback', 'RB'], ['o-fallback', 'WR']]) { const p = input.players.find(p => p.id === id)!; p.position = position; p.fantasyPositions = [position]; }
  assert.deepEqual(recommendTrades(input).candidates, []);
});

test('fairness, risk, position limits, ownership, protected assets and search bounds are enforced', () => {
  const input = demoTradeInput();
  assert.ok(recommendTrades({ ...input, bounds: { maxValueGap: 0 } }).candidates.every(c => c.valueGap === 0));
  assert.equal(recommendTrades({ ...input, bounds: { maxRisk: .1 } }).candidates.length, 0);
  input.signals!.leagues!.demo.protectedTradeIds = ['u-depth', 'u-wr'];
  assert.ok(recommendTrades(input).candidates.every(c => c.give.every(a => !['u-depth', 'u-wr'].includes(a.id))));
  input.signals!.leagues!.demo.positionLimits = { RB: 1 };
  assert.equal(recommendTrades(input).candidates.length, 0);
  const duplicate = demoTradeInput(); duplicate.rosters[1].playerIds.push('u-rb');
  assert.equal(recommendTrades(duplicate).status, 'unavailable');
  for (const bounds of [{ maxValueGap: NaN }, { maxRisk: 2 }, { maxResults: 0 }, { maxResults: 1.2 }, { minNeedGain: 0 }, { surprise: 1 }]) assert.throws(() => parseTradeBounds(bounds));
  const limited = recommendTrades({ ...demoTradeInput(), bounds: { maxAssetsPerTeam: 2, maxResults: 1 } });
  assert.ok(limited.candidates.length <= 1); assert.match(limited.warnings.join(' '), /search limited/);
});

test('unavailable, stale, malformed and incomplete data never leak sample offers', () => {
  for (const mutate of [
    (i: ReturnType<typeof demoTradeInput>) => { i.signals = null; },
    (i: ReturnType<typeof demoTradeInput>) => { i.signals!.players.pop(); },
    (i: ReturnType<typeof demoTradeInput>) => { delete i.signals!.players[0].weeks[0].bye; },
    (i: ReturnType<typeof demoTradeInput>) => { i.signals!.updatedAt = '2020-01-01'; },
    (i: ReturnType<typeof demoTradeInput>) => { i.signals!.players[0].weeks[0].stats.rush_yd = NaN; },
    (i: ReturnType<typeof demoTradeInput>) => { i.rosters[0].synchronizedAt = '2020-01-01'; },
    (i: ReturnType<typeof demoTradeInput>) => { i.league.settings!.disable_trades = 1; },
    (i: ReturnType<typeof demoTradeInput>) => { i.league.settings!.trade_deadline = 7; },
    (i: ReturnType<typeof demoTradeInput>) => { i.league.totalRosters = 12; },
  ]) {
    const input = demoTradeInput(); mutate(input);
    const report = recommendTrades(input); assert.equal(report.status, 'unavailable'); assert.equal(report.candidates.length, 0);
  }
});

test('redraft ignores ages and picks while dynasty uses age, horizon, future stats and strategy', () => {
  const s = demoTradeInput().signals!.players[0];
  const older = { ...s, age: 33 }, shorter = { ...s, expectedCareerYears: 1 };
  assert.equal(valueTradePlayer(s, 10, 20, false), valueTradePlayer(older, 10, 20, false));
  assert.ok(valueTradePlayer(s, 10, 20, true) > valueTradePlayer(older, 10, 20, true));
  assert.ok(valueTradePlayer(s, 10, 20, true) > valueTradePlayer(shorter, 10, 20, true));
  assert.ok(valueTradePlayer(s, 10, 20, true, 'rebuilder') > valueTradePlayer(s, 10, 20, true, 'contender'));
  assert.ok(offers().teams.every(t => t.futureCapital === null));
  const dynasty = demoTradeInput(new Date(), true); delete dynasty.signals!.players[0].age;
  assert.equal(recommendTrades(dynasty).status, 'unavailable');
  const keeper = demoTradeInput(); keeper.league.settings!.type = 1;
  assert.equal(recommendTrades(keeper).status, 'unavailable');
});

test('native rookie picks are overlaid with transfers exactly once; incomplete inventory stays unknown', () => {
  const input = demoTradeInput(new Date(), true), season = String(Number(input.league.season) + 1);
  input.tradedPicks = [{ id: 'transfer', leagueId: 'demo', season, round: 1, rosterId: 1, ownerId: 2, previousOwnerId: 1, sourceUpdatedAt: null, synchronizedAt: input.now!.toISOString() }];
  const report = recommendTrades(input);
  assert.equal(report.teams[0].futureCapital!.picks.length, 2); assert.equal(report.teams[1].futureCapital!.picks.length, 4);
  assert.equal(report.teams.flatMap(t => t.futureCapital!.picks).filter(p => p.id === `pick:${season}:1:1`).length, 1);
  assert.ok(report.candidates.every(c => c.give.every(a => a.id !== `pick:${season}:1:1`)));
  const incomplete = recommendTrades({ ...input, tradedPicks: undefined });
  assert.ok(incomplete.teams.every(t => t.futureCapital === null)); assert.equal(incomplete.status, 'partial');
  assert.ok(incomplete.candidates.every(c => c.give.concat(c.receive).every(a => a.kind === 'player')));
  input.tradedPicks.push({ ...input.tradedPicks[0], id: 'duplicate' });
  assert.equal(recommendTrades(input).status, 'unavailable');
});

test('rebuilder can exchange production for rookie capital only within configured lineup loss', () => {
  const input = demoTradeInput(new Date(), true);
  input.signals!.leagues!.demo.tradeStrategies = { '1': 'contender', '2': 'rebuilder' };
  // Opponent is old, weak at WR, and has no next-year picks; it can rebuild by selling RB surplus.
  for (const s of input.signals!.players.filter(p => p.playerId.startsWith('o-'))) { s.age = 32; s.expectedCareerYears = 2; }
  const season = String(Number(input.league.season) + 1);
  input.tradedPicks = [1, 2, 3].map(round => ({ id: `p${round}`, leagueId: 'demo', season, round, rosterId: 2, ownerId: 1, previousOwnerId: 2, sourceUpdatedAt: null, synchronizedAt: input.now!.toISOString() }));
  const report = recommendTrades({ ...input, bounds: { maxResults: 30, maxValueGap: .4 } });
  assert.equal(report.teams[1].strategy, 'rebuilder'); assert.ok(report.teams[1].needs.some(n => n.kind === 'capital'));
  assert.ok(report.candidates.some(c => c.give.some(a => a.kind === 'pick')), 'actual rookie pick trades are generated');
  assert.ok(report.candidates.every(c => c.partner.after.points >= c.partner.before.points * .9));
  const strict = recommendTrades({ ...input, bounds: { maxRebuilderLineupLoss: 0, maxValueGap: .4 } });
  assert.ok(strict.candidates.every(c => c.partner.after.points >= c.partner.before.points));
});

test('extended signal validation rejects malformed dynasty fields and policy', () => {
  for (const change of [{ age: 10 }, { expectedCareerYears: 0 }, { uncertainty: 2 }, { tradeEligible: 'yes' }]) {
    const signals = demoTradeInput().signals!; Object.assign(signals.players[0], change); assert.throws(() => parseWaiverSignals(signals));
  }
  const signals = demoTradeInput().signals!;
  signals.leagues!.demo.rookieDrafts!.push(signals.leagues!.demo.rookieDrafts![0]);
  assert.throws(() => parseWaiverSignals(signals));
});

test('every player asset shows the league scoring that produced its value; picks show none', () => {
  const report = offers();
  const asset = report.teams.flatMap(t => t.surplus).find(a => a.kind === 'player' && a.positions.includes('RB'))!;
  assert.equal(report.scoringLabel, 'full-PPR');
  assert.ok(report.scoringSnapshotId.startsWith('complete-live:'));
  assert.equal(report.forecastUpdatedAt, '2026-09-08T12:00:00.000Z');
  assert.equal(asset.scoring!.snapshotId, report.scoringSnapshotId);
  assert.equal(asset.scoring!.label, 'full-PPR');
  assert.match(asset.scoring!.explanation, /points under your league's full-PPR scoring/);
  assert.deepEqual(asset.scoring!.contributions.map(c => c.stat), ['rush_yd']);
  assert.equal(asset.scoring!.contributions.reduce((sum, c) => sum + c.points, 0), asset.scoring!.weeklyPoints);
  assert.match(asset.explanation, /under your league's full-PPR scoring/);
  const dynasty = recommendTrades(demoTradeInput(new Date('2026-09-08T12:00:00Z'), true));
  const pick = dynasty.teams.flatMap(t => t.futureCapital?.picks ?? [])[0];
  if (pick) { assert.equal(pick.scoring, null); assert.match(pick.explanation, /no league scoring applies/); }
});

test('a receiver\u2019s value states what this league\u2019s reception rule is specifically worth', () => {
  const report = offers();
  const receiver = report.teams.flatMap(t => t.surplus).find(a => a.positions.includes('WR'))!;
  assert.equal(receiver.opportunity!.archetype, 'volume-driven');
  assert.ok(receiver.opportunity!.receptionPoints > 0);
  assert.match(receiver.explanation, /points come from receptions at 1 per catch/);
  assert.match(receiver.explanation, /Under non-PPR scoring the same stat line projects/);
  assert.match(receiver.explanation, /full-PPR scoring is specifically what elevates this value/);
  // A pure rusher's value is not elevated by reception scoring, and says nothing about it.
  const rusher = report.teams.flatMap(t => t.surplus).find(a => a.positions.includes('RB'))!;
  assert.equal(rusher.opportunity, null);
  assert.doesNotMatch(rusher.explanation, /receptions/);
});

test('an unverifiable rostered projection fails the whole valuation instead of scoring it as zero', () => {
  const input = demoTradeInput(new Date('2026-09-08T12:00:00Z'));
  input.signals!.players[0].weeks.forEach(week => { week.stats = { targets: 4 }; });
  const report = recommendTrades(input);
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.candidates, []);
  assert.equal(report.rejected[0].kind, 'units');
  assert.ok(report.warnings.some(w => /scoring rules do not define/.test(w)));
});
