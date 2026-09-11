import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PostgresStore } from '../../apps/api/src/storage/postgres.js';
import { repositoryContract } from '../../apps/api/src/storage/contract.js';
// @ts-ignore JavaScript test harness; never part of the shipped app.
import { database, migrate } from '../support/database.mjs';
const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const close of cleanups.reverse()) await close(); });
repositoryContract('postgres', async () => {
  const db = await database('contract'); const store = new PostgresStore(db.url);
  cleanups.push(async () => { await store.close(); await db.close(); });
  return store;
});

test('two database clients serialize leases and preserve concurrent account writes', async () => {
  const db = await database('race'); const a = new PostgresStore(db.url), b = new PostgresStore(db.url);
  try {
    const leases = await Promise.all([a.acquireLease('race', 'a', 60_000), b.acquireLease('race', 'b', 60_000)]);
    assert.equal(leases.filter(Boolean).length, 1);
    await Promise.all([
      a.saveApplicationUser({ id: '11111111-1111-1111-1111-111111111111', login: 'one', passwordHash: 'disabled', sleeperLeagueIds: [], createdAt: new Date().toISOString() }),
      b.saveApplicationUser({ id: '22222222-2222-2222-2222-222222222222', login: 'two', passwordHash: 'disabled', sleeperLeagueIds: [], createdAt: new Date().toISOString() }),
    ]);
    assert.ok(await a.applicationUserByLogin('two')); assert.ok(await b.applicationUserByLogin('one'));
    // A rejected database write must roll back without damaging earlier records.
    await assert.rejects(a.saveApplicationUser({ id: '33333333-3333-3333-3333-333333333333', login: 'one', passwordHash: 'disabled', sleeperLeagueIds: [], createdAt: new Date().toISOString() }));
    assert.equal((await b.applicationUserByLogin('one'))?.id, '11111111-1111-1111-1111-111111111111');
  } finally { await Promise.all([a.close(), b.close()]); await db.close(); }
});

test('upgrade from frozen schema 0009 preserves identity, sessions, snapshots and citations', async () => {
  const db = await database('upgrade', { migrateNow: false });
  const client = new pg.Client({ connectionString: db.url }); await client.connect();
  let store: PostgresStore | undefined;
  try {
    await migrate(db.url, 'tests/fixtures/schema-0009');
    const dataset = (await readFile('tests/fixtures/schema-0009/dataset.sql', 'utf8')).replace(/^\\.*$/gm, '');
    await client.query(dataset);
    const before = (await client.query('SELECT to_jsonb(u) AS row FROM app_user u')).rows;
    await migrate(db.url); await migrate(db.url);
    assert.deepEqual((await client.query('SELECT to_jsonb(u) AS row FROM app_user u')).rows, before);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 10);
    store = new PostgresStore(db.url);
    assert.equal((await store.applicationUserByLogin('admin'))?.sleeperUsername, 'manager');
    assert.deepEqual((await store.session('hash1'))?.csrfHashes, ['csrf1']);
    assert.equal((await store.rosters('l1'))[0].coOwnerIds.length, 1);
    assert.equal((await store.weeklySnapshots('l1'))[0].rosters[0].playerIds[0], '4034');
    assert.equal((await store.recommendations({ leagueId: 'l1' }))[0].explanations?.length, 2);
    assert.equal((await store.recommendationOutcomes('33333333-3333-3333-3333-333333333333'))[0].actualPoints, 21.7);
    await store.touchSession('hash1', (await store.session('hash1'))!.expiresAt, new Date().toISOString());
    assert.ok(await store.acquireLease('upgraded', 'worker', 1_000));
  } finally { await store?.close(); await client.end(); await db.close(); }
});
