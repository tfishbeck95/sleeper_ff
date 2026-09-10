import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoringUnavailable } from '@sleeper/domain';
import { createApp } from './app.js';
import { CommandCenterService } from './command-center.js';
import { JsonStore, type ApplicationUser } from './store.js';
import { demoLineupInput } from './test-support/scoring-fixtures.js';
import { signedInAs } from './test-support/auth.js';
import { analyzeLineup, type LineupInput } from './lineup.js';
import { recommendWaivers } from './waivers.js';
import { recommendTrades } from './trades.js';
import { validatedForecastSnapshot } from './waiver-signals.js';

async function fixture() {
  const input = demoLineupInput();
  input.league.id = '1234';
  input.rosters.forEach(r => { r.leagueId = '1234'; r.id = `1234:${r.rosterId}`; });
  input.rosters[0].coOwnerIds = ['coowner'];
  input.matchups!.forEach(m => { m.leagueId = '1234'; });
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'command-center-')), 'data.json'));
  await store.applySync({ league: input.league, rosters: input.rosters, players: input.players, matchups: input.matchups, freshness: { 'players:nfl': input.league.synchronizedAt } });
  const counts = { sync: 0, load: 0, context: 0 };
  const read = store.dashboardContext.bind(store);
  store.dashboardContext = async (...args) => { counts.context++; return read(...args); };
  const sync = { syncLeague: async () => { counts.sync++; } } as never;
  const provider = { load: async () => { counts.load++; return input.signals; } };
  const user: ApplicationUser = { id: 'app-owner', login: 'owner', passwordHash: 'disabled', sleeperUserId: 'sample', sleeperLeagueIds: ['1234'], createdAt: new Date().toISOString() };
  return { input, store, counts, sync, provider, user };
}

test('one sync, atomic read and validated immutable forecast feed all engines with matching provenance', async () => {
  const f = await fixture();
  const seen: LineupInput[] = [];
  const check = (input: LineupInput) => {
    seen.push(input);
    assert.ok(Object.isFrozen(input.league.scoring));
    assert.ok(Object.isFrozen(input.rosters[0].starterIds));
    assert.ok(Object.isFrozen(input.signals!.players[0].weeks[0].stats));
    assert.equal(validatedForecastSnapshot(input.signals), input.signals);
  };
  const service = new CommandCenterService(f.store, f.sync, f.provider, {
    lineup: input => { check(input); return analyzeLineup(input); },
    waivers: input => { check(input); return recommendWaivers(input); },
    trades: input => { check(input); return recommendTrades(input); },
  });
  const result = await service.load(f.user, '1234', 8);
  assert.deepEqual(f.counts, { sync: 1, load: 1, context: 1 });
  assert.equal(result.rosterId, 1);
  assert.equal(seen[0].league, seen[1].league);
  assert.equal(seen[0].signals, seen[2].signals);
  for (const section of Object.values(result.sections)) assert.deepEqual(section.provenance, result.provenance);
  assert.notEqual(result.sections.lineup.state, 'error');
  assert.ok(result.sections.lineup.data!.startSit.length);
  for (const section of [result.sections.lineup, result.sections.waivers, result.sections.trades]) assert.equal(section.data!.scoringSnapshotId, result.provenance.scoringSnapshotId);
  assert.equal(result.sections.lineup.data!.forecast!.updatedAt, result.provenance.forecastUpdatedAt);
  assert.equal(result.sections.waivers.data!.forecastUpdatedAt, result.provenance.forecastUpdatedAt);
  assert.equal(result.sections.trades.data!.forecastUpdatedAt, result.provenance.forecastUpdatedAt);
});

test('optional engine exceptions are isolated, sanitized, and cannot mutate shared evidence', async () => {
  const f = await fixture();
  const service = new CommandCenterService(f.store, f.sync, f.provider, {
    lineup: analyzeLineup, trades: recommendTrades,
    waivers: input => { input.league.name = 'corrupted'; throw new Error('/private/provider.json'); },
  });
  const result = await service.load(f.user, '1234', 8);
  assert.equal(result.sections.waivers.state, 'error');
  assert.equal(result.sections.waivers.data, null);
  assert.notEqual(result.sections.snapshot.data!.league.name, 'corrupted');
  assert.notEqual(result.sections.lineup.state, 'error');
  assert.notEqual(result.sections.trades.state, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private\/provider/);
});

test('missing, invalid, failed and stale forecasts preserve the owner snapshot and starter alerts', async () => {
  for (const mode of ['missing', 'invalid', 'failed', 'stale', 'wrong-week']) {
    const f = await fixture();
    f.input.rosters[0].starterIds[0] = '0';
    await f.store.applySync({ rosters: f.input.rosters, matchups: f.input.matchups });
    const provider = { load: async () => {
      if (mode === 'failed') throw new Error('/private/path');
      if (mode === 'missing') return null;
      if (mode === 'invalid') return { ...f.input.signals!, updatedAt: 'invalid' };
      if (mode === 'wrong-week') return { ...f.input.signals!, week: 9 };
      return { ...f.input.signals!, updatedAt: '2020-01-01T00:00:00Z' };
    } };
    const result = await new CommandCenterService(f.store, f.sync, provider).load(f.user, '1234', 8);
    assert.equal(result.sections.snapshot.state, 'ready');
    assert.ok(result.sections.alerts.data!.some(a => a.kind === 'empty'));
    assert.equal(result.sections.lineup.state, mode === 'stale' ? 'stale' : ['failed', 'invalid'].includes(mode) ? 'error' : 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /private\/path/);
  }
});

test('sync failure retains useful sections; stale ownership and unavailable scoring are explicit', async () => {
  const f = await fixture();
  f.input.rosters.forEach(r => r.synchronizedAt = '2020-01-01T00:00:00Z');
  f.input.league.scoring = scoringUnavailable();
  await f.store.applySync({ league: f.input.league, rosters: f.input.rosters });
  const service = new CommandCenterService(f.store, { syncLeague: async () => { throw new Error('upstream'); } }, f.provider);
  const result = await service.load(f.user, '1234', 8);
  assert.equal(result.sections.snapshot.state, 'stale');
  assert.equal(result.sections.scoring.state, 'unavailable');
  assert.equal(result.sections.trades.state, 'stale');
  assert.ok(result.sections.snapshot.warnings.some(w => w.includes('synchronization failed')));
  assert.equal(result.sections.trades.data!.forecastUpdatedAt, result.provenance.forecastUpdatedAt);
});

test('selected week starters and opponent are shared by alerts and lineup', async () => {
  const f = await fixture();
  const matchups = structuredClone(f.input.matchups!);
  matchups[0].starterIds[0] = '0';
  await f.store.applySync({ matchups });
  const result = await new CommandCenterService(f.store, f.sync, f.provider).load(f.user, '1234', 8);
  assert.equal(result.sections.snapshot.data!.roster.starterIds[0], '0');
  assert.ok(result.sections.alerts.data!.some(a => a.id === 'empty-0'));
  assert.equal(result.sections.lineup.data!.lineup[0].player, null);
  assert.equal(result.sections.matchup.data!.opponentRosterId, 2);
});

test('route authenticates, validates before synchronization, and uses session ownership only', async () => {
  const f = await fixture();
  const app = createApp(f.store, undefined, f.sync, f.provider);
  assert.equal((await request(app).get('/api/command-center/1234?week=8')).status, 401);
  const cookie = (await signedInAs(f.store, { sleeperUserId: 'sample', leagueIds: ['1234'] })).cookie;
  for (const query of ['', 'week=0', 'week=1.5', 'week=19', 'week=8&rosterId=2', 'week=8&maxRisk=oops']) assert.equal((await request(app).get(`/api/command-center/1234?${query}`).set('Cookie', cookie)).status, 400);
  assert.equal(f.counts.sync, 0);
  assert.equal((await request(app).get('/api/command-center/999?week=8').set('Cookie', cookie)).status, 403);
  for (const [owner, status, rosterId] of [['sample', 200, 1], ['coowner', 200, 1], ['stranger', 403, undefined]] as const) {
    const cookie = (await signedInAs(f.store, { sleeperUserId: owner, leagueIds: ['1234'] })).cookie;
    const result = await request(app).get('/api/command-center/1234?week=8').set('Cookie', cookie);
    assert.equal(result.status, status);
    assert.equal(result.body.rosterId, rosterId);
  }
});

test('a concurrent store refresh during forecast loading cannot mix league snapshots', async () => {
  const f = await fixture();
  const provider = { load: async () => {
    await f.store.applySync({ league: { ...f.input.league, scoring: scoringUnavailable(), name: 'Next snapshot' }, rosters: [{ ...f.input.rosters[0], starterIds: ['0'] }] });
    return f.input.signals;
  } };
  const result = await new CommandCenterService(f.store, f.sync, provider).load(f.user, '1234', 8);
  assert.equal(f.counts.context, 1);
  assert.notEqual(result.sections.snapshot.data!.league.name, 'Next snapshot');
  assert.equal(result.sections.scoring.data!.kind, 'complete-live');
  assert.equal(result.sections.lineup.data!.scoringSnapshotId, result.provenance.scoringSnapshotId);
  assert.ok(result.sections.lineup.data!.lineup[0].player);
});
