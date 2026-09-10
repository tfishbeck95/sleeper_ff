import assert from 'node:assert/strict';
import test from 'node:test';
import { validateKickerForecast } from '../kicker.js';
import { deriveKickerForecast } from './derivation.js';
import { NflverseReferenceProvider, parseCsv } from './nflverse.js';
import { SportsDataIoProvider } from './sportsdataio.js';

const text = (body: string) => new Response(body, { status: 200 });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const router = (routes: Array<[string, () => Response]>) => (async (url: string | URL) => {
  const match = routes.find(([fragment]) => String(url).includes(fragment));
  if (!match) throw new Error(`unrouted ${String(url)}`);
  return match[1]();
}) as unknown as typeof fetch;

test('the CSV reader survives the punctuation real player and injury rows contain', () => {
  const rows = parseCsv('name,note\r\n"Beckham, Odell Jr.","said ""ready"" on Friday"\r\nplain,value\r\n');
  assert.deepEqual(rows, [
    { name: 'Beckham, Odell Jr.', note: 'said "ready" on Friday' },
    { name: 'plain', note: 'value' },
  ]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b\n'), []);
});

test('the identity map keeps only rows that can bridge to a Sleeper id', () => {
  const provider = new NflverseReferenceProvider({
    fetcher: router([['db_playerids', () => text(
      'name,position,team,sleeper_id,gsis_id,espn_id,fantasydata_id\n' +
      'Tyreek Hill,WR,MIA,4034,00-0033040,3116406,17257\n' +
      'No Sleeper Row,WR,KC,,00-0000001,NA,NA\n' +
      'Sparse Row,RB,NA,9999,NA,NA,NA\n',
    )]]),
  });
  return provider.identityMap('2026').then(({ links }) => {
    assert.equal(links.length, 2);
    assert.deepEqual(links[0].crossIds, { gsis: '00-0033040', espn: '3116406', fantasydata: '17257' });
    // `NA` is the source's null, and carrying it as an id would collide every sparse row onto one player.
    assert.deepEqual(links[1], { sleeperId: '9999', name: 'Sparse Row', team: null, position: 'RB', crossIds: {} });
  });
});

test('a bye is read as the week a team does not appear in the schedule', async () => {
  const provider = new NflverseReferenceProvider({
    fetcher: router([['games.csv', () => text(
      'season,game_type,week,away_team,home_team\n' +
      '2026,REG,1,MIA,BUF\n2026,REG,1,KC,LAC\n' +
      '2026,REG,2,KC,MIA\n' +
      '2026,REG,3,BUF,LAC\n2026,REG,3,MIA,KC\n' +
      '2025,REG,1,MIA,KC\n',
    )]]),
  });
  const { byes } = await provider.byeWeeks('2026');
  assert.equal(byes.BUF, 2, 'Buffalo is idle in week 2');
  assert.equal(byes.LAC, 2);
  assert.equal(byes.MIA, undefined, 'a team that plays every scheduled week has no bye in this window');
});

test('the official injury report becomes an availability window, not just a label', async () => {
  const provider = new NflverseReferenceProvider({
    fetcher: router([['injuries_2026', () => text(
      'season,week,team,gsis_id,full_name,report_status,practice_status,date_modified\n' +
      '2026,8,MIA,00-0033040,Tyreek Hill,Out,Did Not Participate,2026-10-24T21:00:00Z\n' +
      '2026,8,KC,00-0033873,Some Player,Questionable,Limited Participation,2026-10-24T20:00:00Z\n' +
      '2026,7,MIA,00-0033040,Tyreek Hill,Out,Did Not Participate,2026-10-17T21:00:00Z\n',
    )]]),
  });
  const { reports, sourceTimestamp } = await provider.injuries('2026', 8);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].injury.unavailableThroughWeek, 8);
  assert.equal(reports[0].crossIds.gsis, '00-0033040');
  assert.equal(reports[1].injury.unavailableThroughWeek, null, 'questionable is information, not an absence');
  assert.equal(sourceTimestamp, '2026-10-24T21:00:00.000Z', 'the source timestamp comes from the data, not from our clock');
});

const PROJECTION = {
  PlayerID: 17257, Name: 'Tyreek Hill', Team: 'MIA', Position: 'WR', FantasyPosition: 'WR', Opponent: 'BUF',
  GsisPlayerID: '00-0033040', Receptions: 6.2, ReceivingYards: 82.4, ReceivingTouchdowns: 0.55, ReceivingTargets: 9.1,
  RushingYards: 1.2, FumblesLost: 0.05, PassingYards: 0, Updated: '2026-10-27T11:30:00',
};
const KICKER = {
  PlayerID: 18877, Name: 'Harrison Butker', Team: 'KC', Position: 'K', FantasyPosition: 'K', Opponent: 'LV',
  FieldGoalsAttempted: 2.4, FieldGoalsMade0to19: 0, FieldGoalsMade20to29: 0.49, FieldGoalsMade30to39: 0.74,
  FieldGoalsMade40to49: 0.58, FieldGoalsMade50Plus: 0.19, ExtraPointsAttempted: 2.7, ExtraPointsMade: 2.6, Updated: '2026-10-27T11:00:00',
};
const DEFENSE = {
  Team: 'PIT', Opponent: 'CIN', Sacks: 2.9, Interceptions: 0.9, FumblesForced: 0.8, FumblesRecovered: 0.5,
  Safeties: 0.04, BlockedKicks: 0.05, DefensiveTouchdowns: 0.17, SpecialTeamsTouchdowns: 0.05,
  PointsAllowed: 18.4, OpponentTotalYards: 322, Updated: '2026-10-27T11:15:00',
};
const provider = (extra: Array<[string, () => Response]> = []) => new SportsDataIoProvider({
  apiKey: 'test-key',
  fetcher: router([
    ['PlayerGameProjectionStatsByWeek', () => json([PROJECTION, KICKER])],
    ['FantasyDefenseProjectionsByGame', () => json([DEFENSE])],
    ['Injuries', () => json([{ PlayerID: 17257, Status: 'Questionable', Practice: 'Limited', Updated: '2026-10-26T22:00:00' }])],
    ['PlayerSeasonProjectionStats', () => json([{ PlayerID: 17257, Receptions: 74, ReceivingYards: 980, ReceivingTouchdowns: 6 }])],
    ...extra,
  ]),
});

test('a source row becomes raw statistics, and never a pre-scored points value', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const hill = fetched.players.find(entry => entry.identity.providerId === '17257')!;
  assert.deepEqual(hill.weeks[0].stats, { rec: 6.2, rec_yd: 82.4, rec_td: 0.55, rush_yd: 1.2, fum_lost: 0.05 });
  assert.ok(!('points' in hill.weeks[0].stats) && !('PassingYards' in hill.weeks[0].stats));
  assert.equal(hill.weeks[0].opponent, 'BUF');
  assert.deepEqual(hill.weeks[0].opportunity, { targets: 9.1 });
  assert.equal(hill.identity.crossIds.gsis, '00-0033040');
});

test('a statistic the source reports as zero is left out rather than asserted as a forecast of zero', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const hill = fetched.players.find(entry => entry.identity.providerId === '17257')!;
  assert.ok(!('pass_yd' in hill.weeks[0].stats), 'a receiver with a zero passing line is not projected to attempt a pass');
});

test('kicker attempts per band are recovered from makes, and the result satisfies the kicker contract', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const kicker = fetched.players.find(entry => entry.identity.providerId === '18877')!.weeks[0].kicker!;
  const attempts = Object.values(kicker.fieldGoals).reduce((sum, band) => sum + band.attempts, 0);
  assert.ok(Math.abs(attempts - 2.4) < 1e-9, 'the published attempt total is preserved');
  for (const band of Object.values(kicker.fieldGoals)) assert.ok(band.makes <= band.attempts + 1e-9);
  // Longer attempts convert less often, so the misses Sleeper charges land at plausible distances.
  assert.ok(kicker.fieldGoals['40_49'].attempts - kicker.fieldGoals['40_49'].makes > kicker.fieldGoals['20_29'].attempts - kicker.fieldGoals['20_29'].makes);
  assert.doesNotThrow(() => validateKickerForecast(deriveKickerForecast(kicker).value));
  assert.ok(fetched.notes?.some(note => note.field === 'kicker.fieldGoals.attempts'));
});

test('a team defense arrives as a DEF entity keyed on its team, with its own return events', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const unit = fetched.players.find(entry => entry.identity.position === 'DEF')!;
  assert.equal(unit.identity.team, 'PIT');
  assert.equal(unit.weeks[0].defense?.pointsAllowed, 18.4);
  assert.equal(unit.weeks[0].defense?.yardsAllowed, 322);
  assert.deepEqual(unit.weeks[0].defense?.specialTeams, { touchdowns: 0.05, forcedFumbles: 0, fumbleRecoveries: 0 });
  // Forced fumbles and recoveries are independent Sleeper events and are never derived from each other.
  assert.equal(unit.weeks[0].defense?.forcedFumbles, 0.8);
  assert.equal(unit.weeks[0].defense?.fumbleRecoveries, 0.5);
});

test('the season projection becomes a future typical week, net of the weeks already played', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const hill = fetched.players.find(entry => entry.identity.providerId === '17257')!;
  assert.equal(hill.restOfSeason?.weeksRemaining, 11);
  // 74 season receptions less seven weeks at 6.2, spread over the eleven weeks that remain.
  assert.ok(Math.abs(hill.restOfSeason!.stats.rec - (74 - 6.2 * 7) / 11) < 1e-9);
});

test('the feed timestamp comes from the source rows, so a source that stops publishing looks stale', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  assert.equal(fetched.sourceTimestamp, new Date('2026-10-27T11:30:00').toISOString());
});

test('the injury designation is attached to the player it belongs to', async () => {
  const fetched = await provider().fetchWeek('2026', 8);
  const hill = fetched.players.find(entry => entry.identity.providerId === '17257')!;
  assert.equal(hill.injury?.status, 'Questionable');
  assert.equal(hill.injury?.unavailableThroughWeek, null);
  assert.equal(fetched.players.find(entry => entry.identity.providerId === '18877')!.injury, null);
});

test('the licence and the shortfalls it cannot cover are both declared up front', () => {
  const source = provider();
  assert.equal(source.source.redistributable, false, 'raw records are licensed for use, not for serving onward');
  assert.equal(source.source.credentialEnvVar, 'SPORTSDATAIO_API_KEY');
  assert.equal(source.capabilities.scenarios, 'mean-only');
  assert.equal(source.capabilities.defenseTierDistributions, false);
  assert.equal(source.capabilities.kickerDistanceBands, 'combined-50-plus');
});
