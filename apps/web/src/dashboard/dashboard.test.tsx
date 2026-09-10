import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDemo } from './demo';
import { fromLeagueDetails, rankWaivers, sleeperLeagueUrl, sortAlerts } from './model';
import { Dashboard } from './Dashboard';
import { ActionDialog } from './ActionDialog';
import { MatchupCard } from './components';
import { loadLeague, request } from './api';
import type { LeagueDetails } from './types';

const noop = () => {};
function fixture(): LeagueDetails {
  return {
    league: { league_id: '1234', name: 'Test league', season: '2026', status: 'in_season', roster_positions: ['QB', 'RB', 'WR', 'TE', 'K', 'BN', 'IR'], scoring_settings: { rec: 1 }, settings: { leg: 8, playoff_teams: 2 } },
    rosters: [
      { roster_id: 1, owner_id: 'owner', co_owners: ['me'], players: ['a', 'b', 'c', 'd'], starters: ['a', 'b', 'c', 'd', '0'], settings: { wins: 3, losses: 2, ties: 1, fpts: 600, fpts_decimal: 25 } },
      { roster_id: 2, owner_id: 'other', players: [], starters: [], settings: { wins: 3, losses: 3, fpts: 800 } },
    ],
    users: [{ user_id: 'owner', username: 'owner', display_name: 'My team', avatar: null }, { user_id: 'other', username: 'other', display_name: 'Rival', avatar: null }],
    matchups: [
      { roster_id: 1, matchup_id: 0, points: 10, custom_points: 0, players: [], starters: ['a', 'b', 'c', 'd', '0'] },
      { roster_id: 2, matchup_id: 0, points: 20, players: [], starters: [] },
    ],
    players: { a: { player_id: 'a', full_name: 'Starter A', status: 'Inactive' }, b: { player_id: 'b', full_name: 'Starter B', bye_week: 8 }, c: { player_id: 'c', full_name: 'Starter C', injury_status: 'Questionable' }, d: { player_id: 'd', full_name: 'Starter D', status: 'Active' } },
    transactions: [{ transaction_id: 'tx', type: 'waiver', status: 'complete', roster_ids: [1], adds: { c: 1 }, drops: null, draft_picks: [], created: 1700000000000 }],
    lastSyncedAt: '2026-09-08T12:00:00Z',
  };
}

test('co-owner view detects starter alerts, keeps custom zero scores, and never fabricates projections', () => {
  const data = fromLeagueDetails(fixture(), 'me', 8, null);
  assert.deepEqual(data.alerts.map(a => a.kind), ['inactive', 'bye', 'injury', 'empty']);
  assert.equal(data.matchup?.opponent, 'Rival');
  assert.equal(data.matchup?.actualFor, 0);
  assert.equal(data.matchup?.illustrativeFor, undefined);
  assert.equal(data.standings[0].points, 600.25);
  assert.equal(data.standings[0].isUser, true);
  assert.equal(data.playoffChance, undefined);
  assert.deepEqual(data.starts, []);
  assert.deepEqual(data.waivers, []);
  assert.match(data.activity[0].detail, /Starter C/);
});

test('missing ownership is an error instead of another manager’s dashboard', () => {
  assert.throws(() => fromLeagueDetails(fixture(), 'stranger', 8, null), /no longer owns/);
});

test('null matchup identifiers do not accidentally pair teams and missing player data reports partial sync', () => {
  const input = fixture();
  input.matchups.forEach(m => m.matchup_id = null);
  delete input.players;
  input.playerError = 'Availability sync failed';
  const data = fromLeagueDetails(input, 'me', 8, null);
  assert.equal(data.matchup, null);
  assert.deepEqual(data.alerts.map(a => a.kind), ['empty', 'sync']);
  assert.match(data.coverageNote!, /unavailable/);
});

test('selected week starters take precedence over current roster starters', () => {
  const input = fixture();
  input.rosters[0].starters = ['0', '0', '0', '0', '0'];
  const data = fromLeagueDetails(input, 'me', 8, null);
  assert.equal(data.alerts.filter(a => a.kind === 'empty').length, 1);
});

test('deep links accept only league IDs and always use a fixed HTTPS origin', () => {
  assert.equal(sleeperLeagueUrl('1234567890123456789'), 'https://sleeper.com/leagues/1234567890123456789');
  for (const value of ['demo', '', '../settings', 'javascript:alert(1)', '123?redirect=evil', 'https://evil.test', '123/456']) assert.equal(sleeperLeagueUrl(value), null);
});

test('waivers prioritize fit then advantage without mutating the source', () => {
  const [first, second, third] = createDemo().waivers;
  const items = [{ ...third, fit: 87, advantage: 7 }, first, second];
  assert.deepEqual(rankWaivers(items).map(x => x.id), [first.id, third.id, second.id]);
  assert.equal(items[0].id, third.id);
});

test('sample decisions include consistent advantages and a checklist for every proposed action', () => {
  const data = createDemo();
  assert.deepEqual(sortAlerts(data.alerts).map(a => a.kind), ['inactive', 'bye', 'injury', 'empty', 'sync']);
  for (const item of [...data.starts, ...data.waivers, ...data.trades, ...data.alerts.map(a => a.action)]) assert.ok(item.checklist.length >= 3);
  for (const item of data.starts) assert.ok(Math.abs(item.start!.illustrativePoints! - item.sit!.illustrativePoints! - item.advantage!) < .001);
  for (const item of data.waivers) assert.ok(Math.abs(item.player!.illustrativePoints! - item.drop!.illustrativePoints! - item.advantage!) < .001);
});

test('dashboard renders the requested section order with accessible status and navigation', () => {
  const html = renderToStaticMarkup(<Dashboard connection={null} onConnect={noop} onDemo={noop} onLogout={noop}/>);
  const offsets = ['alerts', 'lineup', 'matchup', 'waivers', 'trades', 'league'].map(id => html.indexOf(`id="${id}"`));
  assert.ok(offsets.every((offset, i) => offset >= 0 && (!i || offset > offsets[i - 1])));
  assert.match(html, /Players are fictional/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Start \/ sit"/);
});

test('a connected dashboard first renders loading, without leaking demo recommendations', () => {
  const input = fixture();
  const html = renderToStaticMarkup(<Dashboard connection={{ user: input.users[0], leagues: [{ league: input.league, roster: input.rosters[0], coOwned: false }] }} onConnect={noop} onDemo={noop} onLogout={noop}/>);
  assert.match(html, /Loading your league/);
  assert.doesNotMatch(html, /Marcus Reed|126\.8|Chris Hayes/);
});

test('checklists remain recommendations and sample actions never link to a real league', () => {
  const action = createDemo().starts[0];
  const sample = renderToStaticMarkup(<ActionDialog action={action} leagueId="1234" demo onClose={noop} onRetry={noop} onConnect={noop}/>);
  assert.doesNotMatch(sample, /href="https:\/\/sleeper/);
  assert.match(sample, /Recommendation · Not confirmed/);
  const live = renderToStaticMarkup(<ActionDialog action={action} leagueId="1234" demo={false} onClose={noop} onRetry={noop} onConnect={noop}/>);
  assert.match(live, /rel="noopener noreferrer"/);
  assert.match(live, /type="checkbox"/);
  assert.match(live, /does not submit or confirm/);
});

test('missing matchup renders a useful empty state', () => {
  const html = renderToStaticMarkup(<MatchupCard data={{ ...createDemo(), matchup: null }}/>);
  assert.match(html, /No matchup available/);
  assert.doesNotMatch(html, /58%/);
});

test('API preserves league data when player sync fails and surfaces authenticated API failures', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input, options) => {
      calls.push(String(input));
      if (String(input).includes('/players/nfl')) throw new Error('Offline');
      assert.equal(options?.credentials, 'include');
      return new Response(JSON.stringify(fixture()), { status: 200 });
    };
    const result = await loadLeague('1234', 8, new AbortController().signal);
    assert.equal(result.details.league.league_id, '1234');
    assert.match(result.details.playerError!, /incomplete/);
    assert.equal(calls.length, 2);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    await assert.rejects(request('/api/example'), /Unauthorized/);
  } finally { globalThis.fetch = original; }
});

test('scoring UI shows the validated snapshot timestamp, summary and additional rules', async () => {
  const { EXPECTED_SCORING, liveScoring, referenceScoring } = await import('@sleeper/domain');
  const { ScoringStatus } = await import('./ScoringStatus');
  const input = fixture();
  input.scoring = liveScoring({ ...EXPECTED_SCORING, bonus_rec_te: .5 }, input.lastSyncedAt);
  const data = fromLeagueDetails(input, 'me', 8, null);
  assert.deepEqual(data.scoring, input.scoring);
  const html = renderToStaticMarkup(<ScoringStatus scoring={data.scoring}/>);
  assert.match(html, /Validated live scoring/); assert.match(html, /PPR.*Pass TD 4/);
  assert.ok(html.includes(`dateTime="${input.lastSyncedAt}"`));
  assert.match(html, /1 additional Sleeper rule/); assert.match(html, /bonus_rec_te/);
  assert.match(renderToStaticMarkup(<ScoringStatus scoring={referenceScoring()}/>), /cannot produce actionable rankings/);
  delete input.scoring;
  assert.match(fromLeagueDetails(input, 'me', 8, null).format, /Scoring unavailable/);
  const missing = liveScoring({ rec: .5 }, input.lastSyncedAt);
  const invalid = renderToStaticMarkup(<ScoringStatus scoring={missing}/>);
  assert.match(invalid, /rankings disabled/); assert.match(invalid, /rec: documented 1, Sleeper 0.5/);
});
