import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../store.js';
import { configureProjectionFeed, currentNflWeek, projectionFeedEnabled, serviceLevelFromEnv } from './configure.js';
import type { ProjectionProvider, ReferenceDataProvider } from './provider.js';

const stubProjections: ProjectionProvider = {
  source: { name: 'Stub', license: 'test', licenseUrl: 'https://example.invalid', attribution: null, redistributable: false, credentialEnvVar: null },
  capabilities: { scenarios: 'mean-only', restOfSeason: false, opportunity: false, kickerDistanceBands: 'none', defenseTierDistributions: false, individualSpecialTeams: false },
  fetchWeek: async () => ({ sourceTimestamp: '2026-10-27T11:00:00.000Z', players: [] }),
};
const stubReference: ReferenceDataProvider = {
  source: { name: 'Stub reference', license: 'CC BY 4.0', licenseUrl: 'https://example.invalid', attribution: null, redistributable: true, credentialEnvVar: null },
  identityMap: async () => ({ sourceTimestamp: '2026-10-27T11:00:00.000Z', links: [] }),
  byeWeeks: async () => ({ sourceTimestamp: '2026-10-27T11:00:00.000Z', byes: {} }),
  injuries: async () => ({ sourceTimestamp: '2026-10-27T11:00:00.000Z', reports: [] }),
};

test('the adapter stays entirely absent unless it is switched on', async () => {
  assert.equal(projectionFeedEnabled({}), false);
  assert.equal(projectionFeedEnabled({ PROJECTION_FEED_ENABLED: 'false' }), false);
  assert.equal(projectionFeedEnabled({ PROJECTION_FEED_ENABLED: 'true' }), true);
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'cfg-')), 'store.json'));
  assert.equal(configureProjectionFeed(store, { env: {} }), null, 'an installation with no data licence is unchanged');
});

test('service-level thresholds come from the environment, with documented defaults', () => {
  assert.deepEqual(serviceLevelFromEnv({}), {
    minIdentityMatchRate: 0.95, maxSourceAgeMs: 6 * 3_600_000, maxIngestionAgeMs: 12 * 3_600_000,
    requireCompleteCoverage: false, minPlayers: 300,
  });
  const configured = serviceLevelFromEnv({
    PROJECTION_FEED_MIN_IDENTITY_MATCH: '0.99', PROJECTION_FEED_MAX_SOURCE_AGE_HOURS: '3',
    PROJECTION_FEED_STALE_HOURS: '8', PROJECTION_FEED_REQUIRE_COMPLETE_COVERAGE: 'true', PROJECTION_FEED_MIN_PLAYERS: '450',
  });
  assert.equal(configured.minIdentityMatchRate, 0.99);
  assert.equal(configured.maxIngestionAgeMs, 8 * 3_600_000);
  assert.equal(configured.requireCompleteCoverage, true);
  assert.equal(configured.minPlayers, 450);
  // A malformed value falls back to the default rather than silently disabling a threshold.
  assert.equal(serviceLevelFromEnv({ PROJECTION_FEED_MIN_PLAYERS: 'many' }).minPlayers, 300);
});

test('the current week is anchored to the Tuesday of the week containing Labor Day', () => {
  const env = { NFL_SEASON: '2026' };
  assert.deepEqual(currentNflWeek(new Date('2026-09-08T12:00:00Z'), env), { season: '2026', week: 1 });
  assert.deepEqual(currentNflWeek(new Date('2026-09-14T23:00:00Z'), env), { season: '2026', week: 1 }, 'Monday night still belongs to the week that is ending');
  assert.deepEqual(currentNflWeek(new Date('2026-09-15T12:00:00Z'), env), { season: '2026', week: 2 }, 'the week rolls over on Tuesday, when waivers open');
  assert.deepEqual(currentNflWeek(new Date('2026-10-27T12:00:00Z'), env), { season: '2026', week: 8 });
});

test('the week is clamped to the regular season rather than running off either end', () => {
  const env = { NFL_SEASON: '2026' };
  assert.equal(currentNflWeek(new Date('2026-07-01T12:00:00Z'), env).week, 1);
  assert.equal(currentNflWeek(new Date('2027-02-01T12:00:00Z'), env).week, 18);
});

test('a season that runs into January still reports the season it started in', () => {
  assert.equal(currentNflWeek(new Date('2027-01-05T12:00:00Z'), {}).season, '2026');
  assert.equal(currentNflWeek(new Date('2026-11-05T12:00:00Z'), {}).season, '2026');
});

test('an explicit anchor overrides the computed one, for a season that moves', () => {
  const week = currentNflWeek(new Date('2026-09-22T12:00:00Z'), { NFL_SEASON: '2026', NFL_WEEK_ONE_TUESDAY: '2026-09-15T00:00:00Z' });
  assert.deepEqual(week, { season: '2026', week: 2 });
});

test('when switched on, the store, the ingestion service and the schedule are all wired together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfg-'));
  const store = new JsonStore(join(directory, 'store.json'));
  const runtime = configureProjectionFeed(store, {
    env: { PROJECTION_FEED_ENABLED: 'true', PROJECTION_FEED_PATH: join(directory, 'feed.json'), NFL_SEASON: '2026', PROJECTION_FEED_MIN_PLAYERS: '0' },
    projections: stubProjections, reference: stubReference, schedule: { runOnStart: false },
  });
  assert.ok(runtime);
  // The feed store is the WaiverSignalProvider the waiver, lineup and trade endpoints already consume.
  assert.equal(typeof runtime!.store.load, 'function');
  const report = await runtime!.ingestion.ingest('2026', 8);
  assert.equal(report.status, 'published');
  assert.equal((await runtime!.store.state('2026', 8))?.players, 0);
});
