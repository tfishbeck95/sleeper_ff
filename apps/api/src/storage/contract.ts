import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, liveScoring, scoringSnapshotId } from '@sleeper/domain';
import type { League, Roster, TradedDraftPick, WeeklySnapshot } from '@sleeper/domain';
import type { HuddleRepository } from './repositories.js';

/**
 * The conformance suite every adapter has to pass.
 *
 * These are the promises the application relies on and neither adapter may reinterpret: Sleeper ids
 * and snapshot ids are keys, an authoritative replacement lands whole, observations are append-only,
 * advice may only cite its own league's rules, leases are mutually exclusive, and retention removes a
 * league's data without touching the directory that belongs to every league.
 *
 * It is written against the interface alone, so the PostgreSQL adapter runs exactly this suite: call
 * `repositoryContract('postgres', factory)` from a test file that can reach a database.
 */

const AT = '2026-10-06T12:00:00.000Z';
const scoring = liveScoring(EXPECTED_SCORING, AT);
export const SNAPSHOT_ID = scoringSnapshotId(scoring);

export const aLeague = (id: string, overrides: Partial<League> = {}): League => ({
  id, name: `League ${id}`, season: '2026', status: 'in_season', previousLeagueId: null, totalRosters: 12,
  rosterPositions: [{ position: 'QB', slot: 0 }], scoringSettings: [], settings: { leg: 5 }, scoring,
  sourceUpdatedAt: null, synchronizedAt: AT, ...overrides,
});
export const aRoster = (leagueId: string, rosterId: number, overrides: Partial<Roster> = {}): Roster => ({
  id: `${leagueId}:${rosterId}`, leagueId, rosterId, ownerId: `u${rosterId}`, coOwnerIds: [],
  playerIds: ['4034'], starterIds: ['4034'], reserveIds: [], taxiIds: [], settings: {},
  sourceUpdatedAt: null, synchronizedAt: AT, ...overrides,
});
const aPick = (leagueId: string, round: number, ownerId: number): TradedDraftPick => ({
  id: `${leagueId}:2027:${round}:1`, leagueId, season: '2027', round, rosterId: 1, previousOwnerId: null, ownerId,
  sourceUpdatedAt: null, synchronizedAt: AT,
});
const anObservation = (leagueId: string, at: string): WeeklySnapshot => ({
  id: `${leagueId}:2026:5:${at}`, leagueId, season: '2026', week: 5, rosterIds: [`${leagueId}:1`], matchupIds: [],
  rosters: [aRoster(leagueId, 1)], matchups: [], scoring, sourceUpdatedAt: null, synchronizedAt: at,
});
const anAccount = (id: string, leagueIds: string[] = []) => ({
  id, login: id, passwordHash: 'disabled', sleeperLeagueIds: leagueIds, createdAt: AT,
});
const aSession = (idHash: string, userId: string, overrides = {}) => ({
  idHash, userId, familyId: '9565c156-fd14-5adf-8580-178576eb699c', csrfHashes: [], createdAt: AT,
  expiresAt: '2026-10-06T14:00:00.000Z', absoluteExpiresAt: '2026-10-07T12:00:00.000Z',
  lastRotatedAt: AT, lastSeenAt: AT, ...overrides,
});
const anAdvice = (leagueId: string, id: string, overrides = {}) => ({
  id, leagueId, season: '2026', week: 5, rosterId: 1, kind: 'start' as const, subjectPlayerId: '4034',
  title: 'Start Player One', rationale: 'Highest projected eligible starter.', confidence: 0.72,
  projectedPoints: 18.4, scoringSnapshotId: SNAPSHOT_ID, generatedAt: AT, ...overrides,
});
const aForecast = (id: string, overrides = {}) => ({
  id, source: 'sportsdataio', season: '2026', week: 5,
  sourceUpdatedAt: '2026-10-06T06:00:00.000Z', ingestedAt: '2026-10-06T06:05:00.000Z', playerCount: 412, ...overrides,
});

export function repositoryContract(name: string, create: () => Promise<HuddleRepository>) {
  const label = (what: string) => `${name} adapter: ${what}`;

  test(label('keys records by their Sleeper id, and an observation by its snapshot id'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1'), rosters: [aRoster('l1', 1)] });
    await store.applySync({ league: aLeague('l1', { name: 'Renamed' }), rosters: [aRoster('l1', 1, { playerIds: ['4034', '5000'] })] });
    assert.equal((await store.league('l1'))!.name, 'Renamed', 'one row per Sleeper league');
    assert.equal((await store.rosters('l1')).length, 1, 'one row per league roster slot');
    assert.deepEqual((await store.rosters('l1'))[0].playerIds, ['4034', '5000']);

    const observation = anObservation('l1', AT);
    await store.applySync({ weeklySnapshot: observation });
    await store.applySync({ weeklySnapshot: { ...observation, week: 6 } });
    const stored = await store.weeklySnapshots('l1');
    assert.equal(stored.length, 1, 'retrying an observation is idempotent, not a second observation');
    assert.equal(stored[0].week, 5, 'and never rewrites the one already recorded');
    await store.applySync({ weeklySnapshot: anObservation('l1', '2026-10-06T13:00:00.000Z') });
    assert.equal((await store.weeklySnapshots('l1')).length, 2);
    assert.equal((await store.weeklySnapshots('l1', { limit: 1 }))[0].synchronizedAt, '2026-10-06T13:00:00.000Z', 'newest first');
  });

  test(label('replaces an authoritative set whole, and leaves other leagues alone'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    await store.applySync({ league: aLeague('l2') });
    const at = { 'draftPicks:l1': new Date().toISOString(), 'draftPicks:l2': new Date().toISOString() };
    await store.applySync({ draftPicks: [aPick('l1', 1, 2), aPick('l1', 2, 2)], replaceDraftPicksForLeague: 'l1', freshness: at });
    await store.applySync({ draftPicks: [aPick('l2', 1, 3)], replaceDraftPicksForLeague: 'l2', freshness: at });
    // The second round returns to its original owner, so Sleeper stops reporting it at all.
    await store.applySync({ draftPicks: [aPick('l1', 1, 2)], replaceDraftPicksForLeague: 'l1', freshness: at });
    const picks = (await store.tradeContext('l1')).tradedPicks!;
    assert.deepEqual(picks.map(pick => pick.round), [1], 'a returned pick does not keep its old owner');
    assert.equal((await store.tradeContext('l2')).tradedPicks!.length, 1, "and another league's transfers are untouched");
  });

  test(label('records a scoring observation with the league that produced it'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    const observations = await store.scoringSnapshots('l1');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].id, SNAPSHOT_ID);
    assert.equal(observations[0].kind, 'complete-live');
    assert.ok(await store.scoringSnapshot('l1', SNAPSHOT_ID));
    assert.equal(await store.scoringSnapshot('l2', SNAPSHOT_ID), undefined, 'scoped to its own league');
    // Re-synchronizing the same rules is the same observation.
    await store.applySync({ league: aLeague('l1') });
    assert.equal((await store.scoringSnapshots('l1')).length, 1);
  });

  test(label('refuses advice that cites another league, and a coverage note that carries weight'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    await store.applySync({ league: aLeague('l2', { scoring: liveScoring({ ...EXPECTED_SCORING, rec: 0.5 }, AT) }) });
    assert.equal(await store.saveRecommendations([anAdvice('l1', '86f801de-3697-58af-8939-08890d36dd6f')]), 1);
    await assert.rejects(store.saveRecommendations([anAdvice('l2', 'aec7ddeb-64d2-5d7b-b00f-1281d8e0f0ac')]), /not an observation of league l2/,
      "points scored under one commissioner's rules may not rank another league");
    await assert.rejects(store.saveRecommendations([anAdvice('l1', 'e666e4e9-e0d3-52db-b5fc-67a614c5a60d', { forecastSnapshotId: 'absent' })]), /not stored/);
    await assert.rejects(store.saveRecommendations([anAdvice('l1', '47d2410e-0ec7-5b63-b78c-b7e6ddc82f3c', {
      explanations: [{ ordinal: 0, kind: 'coverage', label: 'Returns not modelled', detail: 'No st_td.', points: 1.5 }],
    })]), /contributes exactly zero/);
    await assert.rejects(store.saveRecommendations([anAdvice('l1', 'd3eef2af-3aa8-58f4-b883-5f227d30203a', {
      explanations: [
        { ordinal: 0, kind: 'contribution', label: 'Rushing', detail: '68.2 yards.', points: 6.82 },
        { ordinal: 0, kind: 'risk', label: 'Questionable', detail: 'Limited in practice.' },
      ],
    })]), /two explanations at ordinal 0/);
    assert.equal((await store.recommendations({ leagueId: 'l1' })).length, 1, 'a refused batch stored nothing');
  });

  test(label('records outcomes as observations rather than edits'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    await store.saveRecommendations([anAdvice('l1', '86f801de-3697-58af-8939-08890d36dd6f')]);
    const outcome = { id: '59002135-3099-5c1a-814e-247bd7f0a400', recommendationId: '86f801de-3697-58af-8939-08890d36dd6f', observedAt: '2026-10-13T04:00:00.000Z', resolution: 'followed' as const, projectedPoints: 18.4, actualPoints: 21.7, recordedAt: AT };
    await store.recordRecommendationOutcome(outcome);
    await store.recordRecommendationOutcome({ ...outcome, id: '356c2204-0f18-521b-b312-0fb84205a62a', actualPoints: 99 });
    assert.deepEqual((await store.recommendationOutcomes('86f801de-3697-58af-8939-08890d36dd6f')).map(value => value.actualPoints), [21.7],
      're-recording the same observation is not a rewrite');
    // A stat correction is a later observation, and both are kept.
    await store.recordRecommendationOutcome({ ...outcome, id: '2a8184e9-2c33-5f62-9aa2-33276e0aa3a4', observedAt: '2026-10-14T04:00:00.000Z', actualPoints: 20.9 });
    assert.equal((await store.recommendationOutcomes('86f801de-3697-58af-8939-08890d36dd6f')).length, 2);
    await assert.rejects(store.recordRecommendationOutcome({ ...outcome, id: 'ebd63108-bfcf-5b02-a929-6a66b3cd6220', recommendationId: 'absent' }), /unknown recommendation/);
    await assert.rejects(store.recordRecommendationOutcome({ ...outcome, id: '7c9ade98-f7fb-512f-a199-5b37b006e2c5', observedAt: AT, actualPoints: null }), /records no scored points/);
  });

  test(label('keeps the forecast a retained recommendation cites'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    await store.saveForecastSnapshot(aForecast('cited', { sourceUpdatedAt: '2026-01-01T00:00:00.000Z', ingestedAt: '2026-01-01T00:05:00.000Z' }));
    await store.saveForecastSnapshot(aForecast('uncited', { sourceUpdatedAt: '2026-01-02T00:00:00.000Z', ingestedAt: '2026-01-02T00:05:00.000Z' }));
    await store.saveForecastSnapshot(aForecast('newest', { ingestedAt: '2026-10-06T06:05:00.000Z' }));
    await store.saveRecommendations([anAdvice('l1', '86f801de-3697-58af-8939-08890d36dd6f', { forecastSnapshotId: 'cited' })]);
    assert.equal(await store.pruneForecastSnapshots('2026-06-01T00:00:00.000Z'), 1);
    assert.ok(await store.forecastSnapshot('cited'), 'a citation nothing can check is worse than the storage it saves');
    assert.ok(await store.forecastSnapshot('newest'), 'the newest ingestion for a week is always kept');
    assert.equal(await store.forecastSnapshot('uncited'), undefined);
    assert.equal((await store.latestForecastSnapshot('2026', 5))!.id, 'newest');
  });

  test(label('resolves one external identity to one player, or to nothing'), async () => {
    const store = await create();
    await store.applySync({ players: ['4034', '5000'].map(id => ({ id, firstName: 'Player', lastName: id, fullName: `Player ${id}`, team: null, position: 'RB', fantasyPositions: ['RB'], status: null, sourceUpdatedAt: null, synchronizedAt: AT })) });
    const alias = { source: 'sportsdataio', aliasKey: '17539', playerId: '4034', kind: 'cross-id' as const, observedAt: AT };
    assert.equal(await store.savePlayerAliases('sportsdataio', [alias]), 1);
    await assert.rejects(store.savePlayerAliases('sportsdataio', [alias, { ...alias, playerId: '5000' }]), /both 4034 and 5000/);
    await assert.rejects(store.savePlayerAliases('sportsdataio', [{ ...alias, source: 'nflverse' }]), /supplied to a sportsdataio replacement/);
    assert.deepEqual((await store.playerAliases('sportsdataio')).map(value => value.playerId), ['4034'], 'a refused replacement changed nothing');
    // A replacement is scoped to its source.
    await store.savePlayerAliases('nflverse', [{ ...alias, source: 'nflverse', aliasKey: '00-0034796' }]);
    await store.savePlayerAliases('sportsdataio', [{ ...alias, aliasKey: '17540', playerId: '5000' }]);
    assert.deepEqual((await store.playerAliases('sportsdataio')).map(value => value.aliasKey), ['17540']);
    assert.equal((await store.playerAliases('nflverse')).length, 1);
    assert.equal((await store.playerAliases()).length, 2);
    assert.equal(await store.prunePlayerAliases('nflverse', '2026-10-07T00:00:00.000Z'), 1);
  });

  test(label('keeps roster history as observations, and thins it by week'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1') });
    const observation = (rosterId: number, at: string) => ({
      id: `l1:${rosterId}:${at}`, leagueId: 'l1', rosterId, season: '2026', week: 5, observedAt: at,
      ownerId: `u${rosterId}`, coOwnerIds: [], playerIds: ['4034'], starterIds: ['4034'], reserveIds: [], taxiIds: [], settings: {},
    });
    assert.equal(await store.recordRosterObservations([observation(1, AT), observation(2, AT)]), 2);
    assert.equal(await store.recordRosterObservations([observation(1, AT)]), 0, 'append-only and idempotent');
    await store.recordRosterObservations([observation(1, '2026-10-06T13:00:00.000Z')]);
    assert.equal((await store.rosterHistory('l1')).length, 3);
    assert.equal((await store.rosterHistory('l1', { rosterId: 1 })).length, 2);
    assert.equal((await store.rosterHistory('l1', { week: 6 })).length, 0);
    assert.equal((await store.rosterHistory('l1', { rosterId: 1, limit: 1 }))[0].observedAt, '2026-10-06T13:00:00.000Z');
    assert.equal(await store.pruneRosterHistory('2026-10-07T00:00:00.000Z'), 1, 'the newest observation of each roster-week survives');
    assert.equal((await store.rosterHistory('l1')).length, 2);
  });

  test(label('gives one owner the lease, and hands it on only when it expires'), async () => {
    const store = await create();
    const now = new Date(AT);
    assert.ok(await store.acquireLease('league-sync:sweep', 'worker-a', 600_000, now));
    assert.equal(await store.acquireLease('league-sync:sweep', 'worker-b', 600_000, now), null, 'a refusal, never a lease that only looks taken');
    const renewed = await store.acquireLease('league-sync:sweep', 'worker-a', 1_200_000, now);
    assert.equal(renewed!.acquiredAt, AT, 'renewing keeps the time the lease was taken');
    const later = new Date(Date.parse(AT) + 1_800_000);
    assert.ok(await store.acquireLease('league-sync:sweep', 'worker-b', 600_000, later), 'an expired lease is takeable');
    await store.releaseLease('league-sync:sweep', 'worker-a');
    assert.equal((await store.lease('league-sync:sweep'))!.owner, 'worker-b', 'release is scoped to the owner');
  });

  test(label('links a Sleeper account, and reports who links a league'), async () => {
    const store = await create();
    await store.saveApplicationUser(anAccount('1e1e0383-c29c-5351-9618-324be2752ba5'));
    await store.saveApplicationUser(anAccount('254b8b14-f79d-5523-b320-9d636be12e3a'));
    await store.linkSleeperAccount({ userId: '1e1e0383-c29c-5351-9618-324be2752ba5', sleeperUserId: 'u1', sleeperUsername: 'manager', leagueIds: ['l1', 'l1', 'l2'], linkedAt: AT });
    await store.linkSleeperAccount({ userId: '254b8b14-f79d-5523-b320-9d636be12e3a', sleeperUserId: 'u2', sleeperUsername: 'other', leagueIds: ['l2'], linkedAt: AT });
    const link = (await store.sleeperAccount('1e1e0383-c29c-5351-9618-324be2752ba5'))!;
    assert.equal(link.sleeperUsername, 'manager');
    assert.deepEqual(link.leagueIds, ['l1', 'l2'], 'a league is linked once');
    assert.deepEqual(await store.accountsLinkingLeague('l2'), ['1e1e0383-c29c-5351-9618-324be2752ba5', '254b8b14-f79d-5523-b320-9d636be12e3a']);
    assert.deepEqual((await store.linkedLeagueIds()).sort(), ['l1', 'l2']);
    await assert.rejects(store.linkSleeperAccount({ userId: 'absent', sleeperUserId: 'u3', sleeperUsername: 'x', leagueIds: [], linkedAt: AT }), /unknown application account/);
    await store.unlinkSleeperAccount('1e1e0383-c29c-5351-9618-324be2752ba5');
    assert.equal(await store.sleeperAccount('1e1e0383-c29c-5351-9618-324be2752ba5'), undefined);
    assert.deepEqual(await store.accountsLinkingLeague('l2'), ['254b8b14-f79d-5523-b320-9d636be12e3a']);
  });

  test(label('rotates and revokes sessions as whole families'), async () => {
    const store = await create();
    await store.saveApplicationUser(anAccount('1e1e0383-c29c-5351-9618-324be2752ba5'));
    await store.saveSession(aSession('hash-1', '1e1e0383-c29c-5351-9618-324be2752ba5'));
    await store.rotateSession('hash-1', aSession('hash-2', '1e1e0383-c29c-5351-9618-324be2752ba5'), '2026-10-06T12:30:00.000Z');
    assert.equal((await store.session('hash-1'))!.supersededAt, '2026-10-06T12:30:00.000Z', 'the predecessor is retired in the same write');
    assert.ok(await store.session('hash-2'));
    await store.revokeSessionFamily('9565c156-fd14-5adf-8580-178576eb699c', 'reuse-detected', AT);
    assert.equal((await store.session('hash-1'))!.revokedReason, 'reuse-detected');
    assert.equal((await store.session('hash-2'))!.revokedReason, 'reuse-detected');
    // Nothing that can still authenticate is swept.
    await store.saveSession(aSession('hash-3', '1e1e0383-c29c-5351-9618-324be2752ba5', { absoluteExpiresAt: '2027-10-06T12:00:00.000Z', expiresAt: '2027-10-06T12:00:00.000Z' }));
    const removed = await store.pruneSessions(Date.parse('2026-10-20T12:00:00.000Z'), 7 * 24 * 3_600_000);
    assert.equal(removed, 2);
    assert.ok(await store.session('hash-3'));
  });

  test(label('prunes a league without touching what belongs to every league'), async () => {
    const store = await create();
    await store.applySync({ league: aLeague('l1'), rosters: [aRoster('l1', 1)], players: [{ id: '4034', firstName: 'Player', lastName: 'One', fullName: 'Player One', team: 'KC', position: 'RB', fantasyPositions: ['RB'], status: null, sourceUpdatedAt: null, synchronizedAt: AT }], freshness: { 'rosters:l1': AT, 'players:nfl': AT } });
    await store.applySync({ league: aLeague('l2'), rosters: [aRoster('l2', 1)], freshness: { 'rosters:l2': AT } });
    await store.recordRosterObservations([{ id: `l1:1:${AT}`, leagueId: 'l1', rosterId: 1, season: '2026', week: 5, observedAt: AT, ownerId: 'u1', coOwnerIds: [], playerIds: ['4034'], starterIds: ['4034'], reserveIds: [], taxiIds: [], settings: {} }]);
    await store.saveRecommendations([anAdvice('l1', '86f801de-3697-58af-8939-08890d36dd6f')]);
    await store.recordRecommendationOutcome({ id: '59002135-3099-5c1a-814e-247bd7f0a400', recommendationId: '86f801de-3697-58af-8939-08890d36dd6f', observedAt: AT, resolution: 'unknown', recordedAt: AT });
    await store.pruneLeague('l1');
    assert.equal(await store.league('l1'), undefined);
    assert.equal((await store.rosters('l1')).length, 0);
    assert.equal((await store.rosterHistory('l1')).length, 0);
    assert.equal((await store.recommendations({ leagueId: 'l1' })).length, 0);
    assert.equal((await store.recommendationOutcomes('86f801de-3697-58af-8939-08890d36dd6f')).length, 0, 'outcomes follow the advice they grade');
    assert.equal((await store.scoringSnapshots('l1')).length, 0);
    assert.equal(await store.resourceSyncedAt('rosters:l1'), undefined);
    assert.equal((await store.allPlayers()).length, 1, 'the shared directory belongs to every league');
    assert.equal(await store.resourceSyncedAt('players:nfl'), AT);
    assert.ok(await store.league('l2'), 'and another league is untouched');
    assert.equal(await store.resourceSyncedAt('rosters:l2'), AT);
  });

  test(label('records what each synchronization attempt did'), async () => {
    const store = await create();
    await store.connectLeague('l1', { at: AT });
    await store.recordSync('l1', 'success', AT, 1840);
    await store.recordSync('l1', 'failed', '2026-10-06T12:30:00.000Z', 900, 'rate_limit');
    await store.recordSyncRun({
      id: 'players-1', leagueId: null, kind: 'players', status: 'success',
      startedAt: '2026-10-06T13:00:00.000Z', finishedAt: '2026-10-06T13:00:02.000Z', durationMs: 2000, workerId: 'worker-a',
    });
    const runs = await store.syncRuns({ leagueId: 'l1' });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].category, 'rate_limit');
    assert.equal(runs[1].finishedAt, '2026-10-06T12:00:01.840Z', 'a run reports when it finished, not only how long it took');
    assert.equal((await store.syncRuns({ kind: 'players' }))[0].workerId, 'worker-a');
    assert.equal((await store.syncRuns({ status: 'failed' })).length, 1);
    assert.equal(await store.pruneSyncRuns('2026-10-06T12:15:00.000Z', 1), 1, 'each league keeps its most recent attempts');
    assert.equal((await store.syncRuns({ leagueId: 'l1' })).length, 1);
  });
}
