import assert from 'node:assert/strict';
import test from 'node:test';
import type { League } from '@sleeper/domain';
import type { LeagueConnection } from '../store.js';
import { FINAL_WEEK, leagueIsHistorical, resolveSyncTarget } from './week.js';

const env = { NFL_SEASON: '2026', NFL_WEEK_ONE_TUESDAY: '2026-09-08T00:00:00Z' } as NodeJS.ProcessEnv;
const now = new Date('2026-10-06T12:00:00Z'); // Week 5 of the 2026 season.
const league = (overrides: Partial<League> = {}): League => ({
  id: 'l1', name: 'League', season: '2026', status: 'in_season', previousLeagueId: null, totalRosters: 12,
  rosterPositions: [], scoringSettings: [], settings: { leg: 4 }, sourceUpdatedAt: null, synchronizedAt: now.toISOString(), ...overrides,
});
const connection = (overrides: Partial<LeagueConnection> = {}): LeagueConnection => ({
  leagueId: 'l1', demo: false, status: 'active', linked: true, season: '2026', week: 3,
  createdAt: now.toISOString(), updatedAt: now.toISOString(), consecutiveFailures: 0, ...overrides,
});

test('the league’s own week wins while it is playing the season the calendar is in', () => {
  assert.deepEqual(resolveSyncTarget({ league: league(), connection: connection(), now, env }), { season: '2026', week: 4, source: 'league-settings' });
});

test('an unusable league week falls back to the calendar rather than to a guess', () => {
  for (const leg of [undefined, 0, -3, 19, 4.5, Number.NaN]) {
    const target = resolveSyncTarget({ league: league({ settings: leg === undefined ? {} : { leg: leg as number } }), now, env });
    assert.deepEqual(target, { season: '2026', week: 5, source: 'calendar' }, `leg=${String(leg)}`);
  }
});

test('a finished season keeps the week it stopped at, and never advances with the calendar', () => {
  const past = league({ season: '2025', status: 'complete', settings: { leg: 17 } });
  assert.deepEqual(resolveSyncTarget({ league: past, connection: connection({ season: '2025', week: 14 }), now, env }), { season: '2025', week: 14, source: 'persisted' });
  assert.deepEqual(resolveSyncTarget({ league: past, connection: null, now, env }), { season: '2025', week: 17, source: 'persisted' });
  assert.deepEqual(resolveSyncTarget({ league: league({ season: '2025', settings: {} }), connection: null, now, env }), { season: '2025', week: FINAL_WEEK, source: 'final-week' });
});

test('a league already rolled to next season is in its pre-season, not in the calendar’s week', () => {
  assert.deepEqual(resolveSyncTarget({ league: league({ season: '2027', status: 'pre_draft', settings: { leg: 17 } }), now, env }), { season: '2027', week: 1, source: 'calendar' });
});

test('an unsynchronized league uses the calendar, and a malformed season is never trusted', () => {
  assert.deepEqual(resolveSyncTarget({ league: null, connection: null, now, env }), { season: '2026', week: 5, source: 'calendar' });
  assert.deepEqual(resolveSyncTarget({ league: league({ season: 'not-a-season' }), connection: connection({ season: '' }), now, env }), { season: '2026', week: 4, source: 'league-settings' });
});

test('the calendar week is clamped into the regular season', () => {
  const late = new Date('2027-02-01T12:00:00Z'); // Long past week 18 of the 2026 season.
  assert.deepEqual(resolveSyncTarget({ league: league({ settings: {} }), now: late, env }), { season: '2026', week: FINAL_WEEK, source: 'calendar' });
});

test('only a league that can no longer change is historical', () => {
  assert.equal(leagueIsHistorical(league({ season: '2025' }), now, env), true);
  assert.equal(leagueIsHistorical(league({ status: 'complete' }), now, env), false, 'complete during its own season is a finished regular season, not history');
  assert.equal(leagueIsHistorical(league({ status: 'complete' }), new Date('2027-01-20T12:00:00Z'), env), true);
  assert.equal(leagueIsHistorical(league(), now, env), false);
  assert.equal(leagueIsHistorical(null, now, env), false, 'a league that has never been synchronized is unknown, not history');
});
