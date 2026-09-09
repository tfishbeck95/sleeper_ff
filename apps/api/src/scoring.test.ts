import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, liveScoring, referenceScoring, scoringUnavailable, interpretRoster } from '@sleeper/domain';
import { demoWaiverInput, demoTradeInput } from './test-support/scoring-fixtures.js';
import { recommendWaivers } from './waivers.js';
import { recommendTrades } from './trades.js';
import { LeagueEvaluationService } from './evaluation.js';

test('every ranking entry point blocks partial, absent and invalid scoring despite complete forecasts', () => {
  for (const scoring of [undefined, referenceScoring(), scoringUnavailable(), liveScoring({ ...EXPECTED_SCORING, rec: 0 }, new Date().toISOString())]) {
    const waivers = demoWaiverInput(), trades = demoTradeInput();
    waivers.league.scoring = scoring; trades.league.scoring = scoring;
    const w = recommendWaivers(waivers), t = recommendTrades(trades);
    assert.equal(w.status, 'unavailable'); assert.deepEqual(w.recommendations, []); assert.match(w.warnings[0], /complete live scoring/);
    assert.equal(t.status, 'unavailable'); assert.deepEqual(t.candidates, []); assert.deepEqual(t.teams, []);
    assert.throws(() => new LeagueEvaluationService().evaluate({ scoring, rules: interpretRoster(['QB']), format: 'redraft', week: 1, rosters: [], players: [] }), /unavailable/);
  }
});

test('dashboard metadata and recommendation APIs share persisted scoring and fail closed on refresh errors', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { default: request } = await import('supertest');
  const { JsonStore } = await import('./store.js'); const { createApp } = await import('./app.js');
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'scoring-api-')), 'store.json'));
  const input = demoWaiverInput(); input.league.id = '1234';
  input.rosters.forEach(r => { r.leagueId = '1234'; });
  await store.applySync({ league: input.league, rosters: input.rosters, players: input.players });
  let fail = false;
  const raw = { ...EXPECTED_SCORING, bonus_rec_te: .5 };
  const sleeper = {
    league: async () => { if (fail) throw new Error('Offline'); return { league_id: '1234', name: 'Selected league', season: input.league.season, status: 'in_season', roster_positions: ['RB', 'WR', 'TE', 'BN', 'BN', 'BN'], settings: {}, scoring_settings: raw }; },
    rosters: async () => [], leagueUsers: async () => [], matchups: async () => [], transactions: async () => [], drafts: async () => [], tradedPicks: async () => [], players: async () => ({}),
  };
  const app = createApp(store, sleeper as never, undefined, { load: async () => input.signals });
  const get = (path: string) => request(app).get(path).set('Authorization', 'Bearer demo-token');
  const details = await get('/api/sleeper/leagues/1234?week=8');
  assert.equal(details.status, 200); assert.deepEqual(details.body.scoring.settings, raw);
  assert.deepEqual((await store.league('1234'))!.scoring!.rawSettings, raw);
  fail = true;
  for (const path of ['waivers', 'trades']) {
    const response = await get(`/api/${path}/1234?week=8&userId=sample`);
    assert.equal(response.status, 200); assert.equal(response.body.status, 'unavailable');
    assert.equal(response.body.scoring.kind, 'unavailable');
    assert.deepEqual(response.body[path === 'waivers' ? 'recommendations' : 'candidates'], []);
  }
});
