import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, describeStorage, instanceMode, storageConfiguration } from './configure.js';

const env = (values: Record<string, string | undefined>) => values as NodeJS.ProcessEnv;
const PRODUCTION = { NODE_ENV: 'production', DATA_FILE: '/srv/huddle/store.json' };

test('development selects the local adapter without configuration, and says it defaulted', () => {
  const configuration = storageConfiguration(env({ DATA_FILE: '../../data/store.json' }));
  assert.equal(configuration.adapter, 'json');
  assert.equal(configuration.instanceMode, 'single');
  assert.equal(configuration.defaulted, true);
  assert.deepEqual(configuration.warnings, []);
});

test('production requires the adapter to be named', () => {
  assert.throws(() => storageConfiguration(env(PRODUCTION)), /STORAGE_ADAPTER to name the storage adapter explicitly/);
  const named = storageConfiguration(env({ ...PRODUCTION, STORAGE_ADAPTER: 'json' }));
  assert.equal(named.defaulted, false);
  // Allowed, because one instance on a persistent volume is a real deployment — but not a quiet one.
  assert.match(named.warnings.join(' '), /local development profile/);
});

test('an adapter nobody implements is refused by name', () => {
  assert.throws(() => storageConfiguration(env({ STORAGE_ADAPTER: 'sqlite' })), /must be one of json, postgres, not 'sqlite'/);
});

test('the JSON adapter is refused behind several production instances', () => {
  assert.throws(
    () => storageConfiguration(env({ ...PRODUCTION, STORAGE_ADAPTER: 'json', APP_INSTANCE_MODE: 'multi' })),
    /cannot back a multi-instance production deployment[\s\S]*STORAGE_ADAPTER=postgres/,
  );
  // Outside production the same configuration is a warning: it is how someone reproduces the failure.
  const development = storageConfiguration(env({ STORAGE_ADAPTER: 'json', APP_INSTANCE_MODE: 'multi' }));
  assert.match(development.warnings.join(' '), /Writes will be lost and leases will not hold/);
});

test('an instance told another owns the schedule is treated as one of several', () => {
  assert.equal(instanceMode(env({ ...PRODUCTION, SYNC_WORKER_ENABLED: 'false' })), 'multi');
  assert.throws(() => storageConfiguration(env({ ...PRODUCTION, STORAGE_ADAPTER: 'json', SYNC_WORKER_ENABLED: 'false' })), /multi-instance production/);
  // Stating it explicitly wins over the inference, in both directions.
  assert.equal(instanceMode(env({ ...PRODUCTION, SYNC_WORKER_ENABLED: 'false', APP_INSTANCE_MODE: 'single' })), 'single');
  assert.equal(instanceMode(env({ SYNC_WORKER_ENABLED: 'false' })), 'single', 'a development machine is not a fleet');
  assert.throws(() => instanceMode(env({ APP_INSTANCE_MODE: 'cluster' })), /must be 'single' or 'multi'/);
});

test('PostgreSQL requires a connection string and selects the transactional adapter', async () => {
  assert.throws(() => storageConfiguration(env({ ...PRODUCTION, STORAGE_ADAPTER: 'postgres' })), /requires DATABASE_URL/);
  const configuration = storageConfiguration(env({ ...PRODUCTION, STORAGE_ADAPTER: 'postgres', DATABASE_URL: 'postgres://huddle:secret@db:5432/huddle' }));
  assert.equal(configuration.adapter, 'postgres');
  const { repository } = createRepository(env({ ...PRODUCTION, STORAGE_ADAPTER: 'postgres', DATABASE_URL: 'postgres://huddle:secret@db:5432/huddle' }));
  assert.equal(repository.adapter, 'postgres');
  await repository.close?.();
  // A connection string carries a password, so what gets logged is the database, not the URL.
  assert.equal(describeStorage(configuration), 'postgres adapter, single-instance, huddle');
});

test('the selected local adapter is the one the process gets', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'huddle-storage-')), 'store.json');
  const { repository, configuration } = createRepository(env({ STORAGE_ADAPTER: 'json', DATA_FILE: path }));
  assert.equal(repository.adapter, 'json');
  assert.equal(configuration.dataFile, path);
  await repository.saveApplicationUser({ id: 'user-1', login: 'admin', passwordHash: 'disabled', sleeperLeagueIds: [], createdAt: new Date().toISOString() });
  assert.equal((await repository.applicationUserByLogin('admin'))!.id, 'user-1');
  assert.match(describeStorage(configuration), /^json adapter, single-instance, .*store\.json$/);
});
