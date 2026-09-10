import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, liveScoring, referenceScoring, scoringUnavailable, interpretRoster, interpretScoring } from '@sleeper/domain';
import { demoWaiverInput, demoTradeInput, demoLineupInput } from './test-support/scoring-fixtures.js';
import { recommendWaivers } from './waivers.js';
import { recommendTrades } from './trades.js';
import { analyzeLineup } from './lineup.js';
import { scoreLeagueForecasts } from './projection-scoring.js';
import { LeagueEvaluationService } from './evaluation.js';

test('every ranking entry point blocks partial, absent and invalid scoring despite complete forecasts', () => {
  for (const scoring of [undefined, referenceScoring(), scoringUnavailable(), liveScoring({ ...EXPECTED_SCORING, rec: 0 }, new Date().toISOString())]) {
    const waivers = demoWaiverInput(), trades = demoTradeInput(), lineup = demoLineupInput();
    waivers.league.scoring = scoring; trades.league.scoring = scoring; lineup.league.scoring = scoring;
    const w = recommendWaivers(waivers), t = recommendTrades(trades), l = analyzeLineup(lineup);
    assert.equal(w.status, 'unavailable'); assert.deepEqual(w.recommendations, []); assert.match(w.warnings[0], /complete live scoring/);
    assert.equal(t.status, 'unavailable'); assert.deepEqual(t.candidates, []); assert.deepEqual(t.teams, []);
    assert.equal(l.status, 'unavailable'); assert.deepEqual(l.startSit, []); assert.deepEqual(l.lineup, []); assert.equal(l.matchup, null);
    assert.throws(() => new LeagueEvaluationService().evaluate({ scoring, rules: interpretRoster(['QB']), format: 'redraft', week: 1, rosters: [], players: [] }), /unavailable/);
    // The boundary itself refuses, so no path can score raw statistics without a validated snapshot.
    assert.throws(() => scoreLeagueForecasts({ rules: interpretScoring([], scoring ?? scoringUnavailable()), signals: waivers.signals!, players: waivers.players }), /validated complete live scoring snapshot/);
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
  process.env.ENABLE_DEMO_AUTH='true'; process.env.DEMO_SLEEPER_LEAGUE_IDS='demo,1234'; const login=await request(app).post('/auth/demo'); const get = (path: string) => request(app).get(path).set('Cookie',login.headers['set-cookie'][0].split(';')[0]);
  const details = await get('/api/sleeper/leagues/1234?week=8');
  assert.equal(details.status, 200); assert.deepEqual(details.body.scoring.settings, raw);
  assert.deepEqual((await store.league('1234'))!.scoring!.rawSettings, raw);
  fail = true;
  for (const path of ['waivers', 'trades', 'lineup']) {
    const response = await get(`/api/${path}/1234?week=8`);
    assert.equal(response.status, 200); assert.equal(response.body.status, 'unavailable');
    assert.equal(response.body.scoring.kind, 'unavailable');
    assert.deepEqual(response.body[path === 'waivers' ? 'recommendations' : path === 'trades' ? 'candidates' : 'startSit'], []);
  }
});

test('no ranking module scores statistics itself; the boundary is the only path', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const sources = (await readdir(directory)).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const name of sources) {
    if (['projection-scoring.ts'].includes(name)) continue;
    const text = await readFile(join(directory, name), 'utf8');
    assert.doesNotMatch(text, /scoring\.score\(/, `${name} must obtain points from scoreLeagueForecasts, not by scoring statistics itself`);
  }
});
