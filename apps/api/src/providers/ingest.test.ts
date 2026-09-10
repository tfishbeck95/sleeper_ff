import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_SCORING, interpretScoring, liveScoring, type NflPlayer, type ScoringRules } from '@sleeper/domain';
import { parseWaiverSignals } from '../waiver-signals.js';
import { InMemoryFeedRepository, ProjectionFeedStore } from './feed-store.js';
import { mergeInjury, ProjectionIngestionService, type IngestionDependencies } from './ingest.js';
import type { IdentityLink, ProjectionProvider, ProviderFetch, ProviderInjury, ProviderPlayerProjection, ReferenceDataProvider, SourceLicense } from './provider.js';
import { DEFAULT_SERVICE_LEVEL, type AlertEvent, type Alerter, type ServiceLevel } from './service-level.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const SOURCE_AT = '2026-10-27T11:30:00.000Z';
const license = (name: string): SourceLicense => ({ name, license: 'test', licenseUrl: 'https://example.invalid', attribution: null, redistributable: false, credentialEnvVar: null });

const player = (id: string, fullName: string, position: string, team: string | null): NflPlayer => ({
  id, firstName: fullName.split(' ')[0], lastName: fullName.split(' ').slice(1).join(' '), fullName, team, position,
  fantasyPositions: [position], status: 'Active', sourceUpdatedAt: null, synchronizedAt: NOW.toISOString(),
});
const SLEEPER: NflPlayer[] = [
  player('4034', 'Tyreek Hill', 'WR', 'MIA'),
  player('6786', 'Justin Herbert', 'QB', 'LAC'),
  player('5000', 'Harrison Butker', 'K', 'KC'),
  player('PIT', 'Pittsburgh Steelers', 'DEF', 'PIT'),
];
const LINKS: IdentityLink[] = [
  { sleeperId: '4034', name: 'Tyreek Hill', position: 'WR', team: 'MIA', crossIds: { gsis: 'g-hill', fantasydata: '17257' } },
  { sleeperId: '6786', name: 'Justin Herbert', position: 'QB', team: 'LAC', crossIds: { gsis: 'g-herbert', fantasydata: '21684' } },
  { sleeperId: '5000', name: 'Harrison Butker', position: 'K', team: 'KC', crossIds: { fantasydata: '18877' } },
];

const projection = (overrides: Partial<ProviderPlayerProjection> & Pick<ProviderPlayerProjection, 'identity'>): ProviderPlayerProjection =>
  ({ weeks: [], injury: null, ...overrides });

function providers(fetch: ProviderFetch, options: { byes?: Record<string, number>; injuries?: Array<{ crossIds: Record<string, string>; name: string; team: string | null; injury: ProviderInjury }>; failByes?: boolean } = {}) {
  const projections: ProjectionProvider = {
    source: license('Test projections'),
    capabilities: { scenarios: 'mean-only', restOfSeason: true, opportunity: true, kickerDistanceBands: 'combined-50-plus', defenseTierDistributions: false, individualSpecialTeams: false },
    fetchWeek: async () => fetch,
  };
  const reference: ReferenceDataProvider = {
    source: license('Test reference'),
    identityMap: async () => ({ sourceTimestamp: SOURCE_AT, links: LINKS }),
    byeWeeks: async () => { if (options.failByes) throw new Error('schedule mirror is down'); return { sourceTimestamp: SOURCE_AT, byes: options.byes ?? {} }; },
    injuries: async () => ({ sourceTimestamp: SOURCE_AT, reports: options.injuries ?? [] }),
  };
  return { projections, reference };
}

class CapturingAlerter implements Alerter {
  readonly events: AlertEvent[] = [];
  alert(event: AlertEvent) { this.events.push(event); }
}

const liveRules = (): ScoringRules => interpretScoring(EXPECTED_SCORING, liveScoring({ ...EXPECTED_SCORING }, NOW.toISOString()));

function service(fetch: ProviderFetch, options: Parameters<typeof providers>[1] & { level?: Partial<ServiceLevel>; scoring?: IngestionDependencies['scoring'] } = {}) {
  const repository = new InMemoryFeedRepository();
  const store = new ProjectionFeedStore(repository, DEFAULT_SERVICE_LEVEL, () => NOW.getTime());
  const alerter = new CapturingAlerter();
  const { projections, reference } = providers(fetch, options);
  const ingestion = new ProjectionIngestionService({
    projections, reference, store, sleeperPlayers: async () => SLEEPER, alerter,
    level: { ...DEFAULT_SERVICE_LEVEL, minPlayers: 1, ...options.level },
    scoring: options.scoring, now: () => NOW,
  });
  return { ingestion, store, repository, alerter };
}

const HILL = projection({
  identity: { providerId: '17257', name: 'Tyreek Hill', team: 'MIA', position: 'WR', crossIds: { fantasydata: '17257' } },
  weeks: [{ week: 8, stats: { rec: 6.2, rec_yd: 82.4, rec_td: 0.55 }, opponent: 'BUF', opportunity: { targets: 9.1 } }],
  restOfSeason: { stats: { rec: 6, rec_yd: 79, rec_td: 0.5 }, weeksRemaining: 11 },
  injury: null, recentTargets: [9, 8, 11, 10, 9, 8], age: 32,
});
const BUTKER = projection({
  identity: { providerId: '18877', name: 'Harrison Butker', team: 'KC', position: 'K', crossIds: { fantasydata: '18877' } },
  weeks: [{
    week: 8, stats: {}, opponent: 'LV',
    kicker: { fieldGoals: { '0_19': { attempts: 0, makes: 0 }, '20_29': { attempts: 0.5, makes: 0.49 }, '30_39': { attempts: 0.8, makes: 0.74 }, '40_49': { attempts: 0.7, makes: 0.58 }, '50p': { attempts: 0.3, makes: 0.19 } }, pat: { makes: 2.6, misses: 0.08 }, misses: 0.3 },
  }],
});
const STEELERS = projection({
  identity: { providerId: 'DEF:PIT', name: 'Pittsburgh Steelers defense', team: 'PIT', position: 'DEF', crossIds: {} },
  weeks: [{
    week: 8, stats: {}, opponent: 'CIN',
    defense: { sacks: 2.9, interceptions: 0.9, forcedFumbles: 0.8, fumbleRecoveries: 0.5, safeties: 0.04, blockedKicks: 0.05, defensiveTouchdowns: 0.17, pointsAllowed: 18.4, yardsAllowed: 322 },
  }],
});
const UNKNOWN = projection({
  identity: { providerId: '99999', name: 'Never Heardof', team: 'CHI', position: 'RB', crossIds: { fantasydata: '99999' } },
  weeks: [{ week: 8, stats: { rush_yd: 40 } }],
});

test('a complete run publishes a feed that passes the same validation the file adapter applies', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [HILL, BUTKER, STEELERS] });
  const report = await ingestion.ingest('2026', 8);

  assert.equal(report.status, 'published', report.errors.join('; '));
  assert.equal(report.schema.valid, true);
  const feed = await store.load('2026', 8);
  assert.ok(feed, 'the published feed answers the week it was ingested for');
  assert.doesNotThrow(() => parseWaiverSignals(feed));
  assert.deepEqual(feed!.players.map(entry => entry.playerId).sort(), ['4034', '5000', 'PIT']);
});

test('provenance carries the source name, the source timestamp, the ingestion time, season and week', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  await ingestion.ingest('2026', 8);
  const state = await store.state('2026', 8);
  assert.equal(state?.provenance.season, '2026');
  assert.equal(state?.provenance.week, 8);
  assert.equal(state?.provenance.sourceTimestamp, SOURCE_AT);
  assert.equal(state?.provenance.ingestedAt, NOW.toISOString());
  assert.equal(state?.provenance.sourceName, 'Test projections + Test reference');
  assert.deepEqual(state?.provenance.contributions.map(entry => entry.role), ['projections', 'reference']);
  assert.equal(state?.stale, false);
});

test('an unmatched provider row is reported with a reason instead of vanishing', async () => {
  const { ingestion, alerter } = service({ sourceTimestamp: SOURCE_AT, players: [HILL, UNKNOWN] });
  const report = await ingestion.ingest('2026', 8);
  assert.equal(report.unresolvedTotal, 1);
  assert.equal(report.unresolved[0].name, 'Never Heardof');
  assert.equal(report.unresolved[0].reason, 'no-match');
  assert.equal(report.identity.rate, 0.5);
  assert.ok(alerter.events.some(event => event.breaches.some(breach => breach.kind === 'identity')), 'a halved match rate breaches the identity service level');
});

test('a bye week is stated explicitly, because the scoring boundary refuses a week without the flag', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] }, { byes: { MIA: 8 } });
  const report = await ingestion.ingest('2026', 8);
  const week = (await store.load('2026', 8))!.players[0].weeks[0];
  assert.equal(week.bye, true);
  assert.ok(Object.keys(week.stats).length > 0, 'a bye needs a stat line the schema accepts');
  assert.ok(Object.values(week.stats).every(amount => amount === 0), 'on a bye, zero is a fact rather than a guess');
  assert.ok(report.errors.some(error => /the schedule was treated as authoritative/.test(error)), 'the disagreement is reported, not resolved silently');
});

test('a non-bye week still carries an explicit false, never an absent flag', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] }, { byes: { MIA: 11 } });
  await ingestion.ingest('2026', 8);
  assert.equal((await store.load('2026', 8))!.players[0].weeks[0].bye, false);
});

test('an official injury report is merged in, and the longer absence wins', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [{ ...HILL, identity: { ...HILL.identity, crossIds: { fantasydata: '17257', gsis: 'g-hill' } }, injury: { status: 'Questionable', designation: 'Questionable', practiceStatus: 'Limited', unavailableThroughWeek: null, reportedAt: '2026-10-25T12:00:00.000Z' } }] }, {
    injuries: [{ crossIds: { gsis: 'g-hill' }, name: 'Tyreek Hill', team: 'MIA', injury: { status: 'Out', designation: 'Out', practiceStatus: 'Did Not Participate', unavailableThroughWeek: 8, reportedAt: '2026-10-26T20:00:00.000Z' } }],
  });
  await ingestion.ingest('2026', 8);
  const signal = (await store.load('2026', 8))!.players[0];
  assert.equal(signal.injuryStatus, 'Out');
  assert.equal(signal.unavailableThroughWeek, 8);
});

test('the more recent designation is used, and the longer window is kept regardless of which report held it', () => {
  const stale: ProviderInjury = { status: 'Out', designation: 'Out', practiceStatus: null, unavailableThroughWeek: 10, reportedAt: '2026-10-20T00:00:00.000Z' };
  const fresh: ProviderInjury = { status: 'Questionable', designation: 'Questionable', practiceStatus: 'Full', unavailableThroughWeek: null, reportedAt: '2026-10-26T00:00:00.000Z' };
  const merged = mergeInjury(stale, fresh);
  assert.equal(merged?.status, 'Questionable', 'the newer designation is not masked by a stale one');
  assert.equal(merged?.unavailableThroughWeek, 10, 'the longer absence is kept: a wrong start costs more than a wrong bench');
  assert.equal(mergeInjury(null, fresh), fresh);
  assert.equal(mergeInjury(stale, undefined), stale);
  assert.equal(mergeInjury(null, undefined), null);
});

test('remaining-season forecasts are carried through as a future typical week', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  await ingestion.ingest('2026', 8);
  assert.deepEqual((await store.load('2026', 8))!.players[0].dynastyStats, { rec: 6, rec_yd: 79, rec_td: 0.5 });
});

test('kicker distance bands and defensive tier probabilities are derived and disclosed as derived', async () => {
  const { ingestion, store } = service({ sourceTimestamp: SOURCE_AT, players: [BUTKER, STEELERS] });
  const report = await ingestion.ingest('2026', 8);
  const fields = report.derivations.map(note => note.field);
  assert.ok(fields.includes('kicker.fieldGoals.50_59/60p'));
  assert.ok(fields.includes('defense.pointsAllowed'));
  assert.ok(fields.includes('defense.yardsAllowed'));
  assert.ok(report.derivations.every(note => note.basis && note.explanation), 'every derived value names its method and basis');

  const feed = (await store.load('2026', 8))!;
  const kicker = feed.players.find(entry => entry.playerId === '5000')!.weeks[0].kicker!;
  assert.ok(kicker.fieldGoals['50_59'].attempts > 0 && kicker.fieldGoals['60p'].attempts > 0);
  const defense = feed.players.find(entry => entry.playerId === 'PIT')!.weeks[0].defense!;
  assert.ok(Math.abs(Object.values(defense.pointsAllowed.buckets).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('coverage is assessed against the live league, and a gap is reported rather than filled', async () => {
  const { ingestion, alerter } = service({ sourceTimestamp: SOURCE_AT, players: [HILL, BUTKER, STEELERS] }, { scoring: async () => liveRules() });
  const report = await ingestion.ingest('2026', 8);
  assert.equal(report.coverage?.complete, false);
  // This source models no individual return production at all, and the league pays for it.
  for (const stat of ['st_td', 'st_ff', 'st_fum_rec']) assert.ok(report.coverage!.uncovered.includes(stat), `${stat} named`);
  assert.ok(alerter.events.some(event => event.breaches.some(breach => breach.kind === 'coverage')));
  const kicker = report.coverage!.families.find(family => family.family === 'K')!;
  assert.deepEqual(kicker.derived.sort(), ['fgm_50_59', 'fgm_60p']);
});

test('coverage is not assessed, and not assumed complete, without a live scoring snapshot', async () => {
  const { ingestion } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] }, { scoring: async () => null });
  const report = await ingestion.ingest('2026', 8);
  assert.equal(report.coverage, null);
  assert.ok(report.errors.some(error => /no league has a validated complete-live scoring snapshot/.test(error)));
});

test('a mean-only source reports the absence of floor and ceiling scenarios as a source property', async () => {
  const { ingestion } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  const report = await ingestion.ingest('2026', 8);
  assert.deepEqual(report.scenarios, { supported: false, withFloor: 0, withCeiling: 0 });
});

test('a candidate that fails validation is rejected, and the last good feed survives untouched', async () => {
  const repository = new InMemoryFeedRepository();
  const store = new ProjectionFeedStore(repository, DEFAULT_SERVICE_LEVEL, () => NOW.getTime());
  const alerter = new CapturingAlerter();
  const good = providers({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  await new ProjectionIngestionService({ ...good, store, sleeperPlayers: async () => SLEEPER, alerter, level: { ...DEFAULT_SERVICE_LEVEL, minPlayers: 1 }, now: () => NOW }).ingest('2026', 8);
  assert.equal((await store.load('2026', 8))?.players.length, 1);

  // A source that starts emitting an impossible opportunity line must not be able to replace it.
  const poisoned = providers({ sourceTimestamp: SOURCE_AT, players: [{ ...HILL, weeks: [{ week: 8, stats: { rec: 6 }, opportunity: { targets: 900 } }] }] });
  const report = await new ProjectionIngestionService({ ...poisoned, store, sleeperPlayers: async () => SLEEPER, alerter, level: { ...DEFAULT_SERVICE_LEVEL, minPlayers: 1 }, now: () => NOW }).ingest('2026', 8);

  assert.equal(report.status, 'rejected');
  assert.match(report.schema.error!, /Invalid projected targets/);
  const retained = await store.load('2026', 8);
  assert.equal(retained?.players[0].weeks[0].stats.rec_yd, 82.4, 'the previous good feed is still the one being served');
  assert.ok(alerter.events.some(event => event.severity === 'critical' && event.breaches.some(breach => breach.kind === 'schema')));
});

test('an upstream outage fails the run, alerts, and never truncates the stored feed', async () => {
  const repository = new InMemoryFeedRepository();
  const store = new ProjectionFeedStore(repository, DEFAULT_SERVICE_LEVEL, () => NOW.getTime());
  const alerter = new CapturingAlerter();
  const good = providers({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  await new ProjectionIngestionService({ ...good, store, sleeperPlayers: async () => SLEEPER, alerter, level: { ...DEFAULT_SERVICE_LEVEL, minPlayers: 1 }, now: () => NOW }).ingest('2026', 8);

  const down: ProjectionProvider = { ...good.projections, fetchWeek: async () => { throw new Error('502 from upstream'); } };
  const report = await new ProjectionIngestionService({ projections: down, reference: good.reference, store, sleeperPlayers: async () => SLEEPER, alerter, level: { ...DEFAULT_SERVICE_LEVEL, minPlayers: 1 }, now: () => NOW }).ingest('2026', 8);

  assert.equal(report.status, 'failed');
  assert.ok(report.errors.includes('502 from upstream'));
  assert.equal((await store.load('2026', 8))?.players.length, 1);
  assert.equal(alerter.events.at(-1)?.severity, 'critical');
});

test('a reference fetch that is not the identity map degrades instead of failing the run', async () => {
  const { ingestion } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] }, { failByes: true });
  const report = await ingestion.ingest('2026', 8);
  assert.equal(report.status, 'published');
  assert.ok(report.errors.some(error => /Bye weeks unavailable: schedule mirror is down/.test(error)));
});

test('a source returning almost nothing is treated as an outage that answered 200', async () => {
  const { ingestion, alerter } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] }, { level: { minPlayers: 300 } });
  const report = await ingestion.ingest('2026', 8);
  const breach = report.breaches.find(entry => entry.kind === 'volume');
  assert.equal(breach?.severity, 'critical');
  assert.ok(alerter.events.length > 0);
});

test('a source whose own timestamp has stopped moving breaches freshness even though the fetch succeeded', async () => {
  const { ingestion } = service({ sourceTimestamp: '2026-10-25T00:00:00.000Z', players: [HILL] });
  const report = await ingestion.ingest('2026', 8);
  const breach = report.breaches.find(entry => entry.kind === 'freshness');
  assert.equal(breach?.severity, 'critical');
  assert.match(breach!.message, /source failing to publish rather than the ingestion failing to run/);
});

test('overlapping triggers share one run rather than racing on the same feed', async () => {
  const { ingestion } = service({ sourceTimestamp: SOURCE_AT, players: [HILL] });
  const [first, second] = await Promise.all([ingestion.ingest('2026', 8), ingestion.ingest('2026', 8)]);
  assert.equal(first, second);
});

test('a clean run against a fully covered league raises no alert at all', async () => {
  const complete = { ...EXPECTED_SCORING, st_td: 0, st_ff: 0, st_fum_rec: 0, def_st_td: 0, def_st_ff: 0, def_st_fum_rec: 0, fum_rec_td: 0, pass_2pt: 0, rush_2pt: 0, rec_2pt: 0, fum_lost: 0 };
  const { ingestion, alerter } = service({ sourceTimestamp: SOURCE_AT, players: [HILL, BUTKER, STEELERS] }, {
    scoring: async () => interpretScoring(complete, liveScoring(complete, NOW.toISOString())),
  });
  const report = await ingestion.ingest('2026', 8);
  assert.equal(report.status, 'published');
  assert.deepEqual(report.breaches, [], JSON.stringify(report.breaches));
  assert.deepEqual(alerter.events, []);
});
