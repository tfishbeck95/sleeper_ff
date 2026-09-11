import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMigrations, loadMigrations } from './migrations.js';

/**
 * Every table the repository interfaces need, and the migration that creates it.
 *
 * This is the list that keeps the two halves of the contract together: a port added without a table
 * fails here, rather than in the deployment that first selects the PostgreSQL adapter.
 */
const TABLES: Readonly<Record<string, string>> = {
  app_user: '0001', app_session: '0001', app_session_csrf: '0001', sleeper_account: '0001', app_user_league: '0001',
  league_connection: '0002', league: '0002', league_scoring_snapshot: '0002',
  sleeper_user: '0003', roster: '0003', roster_owner: '0003', roster_history: '0003',
  player: '0004', player_directory_state: '0004', player_alias: '0004',
  matchup: '0005', league_transaction: '0005', transaction_player: '0005', transaction_draft_pick: '0005',
  traded_draft_pick: '0005', weekly_snapshot: '0005', weekly_snapshot_matchup: '0005',
  forecast_snapshot: '0006', forecast_player: '0006',
  recommendation: '0007', recommendation_explanation: '0007', recommendation_outcome: '0007',
  sync_run: '0008', resource_freshness: '0008', sync_lease: '0008', dashboard_snapshot: '0010',
};

test('every migration is paired with a rollback and records itself in the ledger', async () => {
  assert.deepEqual(checkMigrations(await loadMigrations()), []);
});

test('the check catches the mistakes that only show up during a deployment', () => {
  const good = { version: '0001', name: 'thing', up: "BEGIN;\nCREATE TABLE t ();\nINSERT INTO schema_migrations (version, name) VALUES ('0001', 'thing');\nCOMMIT;", down: "BEGIN;\nDROP TABLE t;\nDELETE FROM schema_migrations WHERE version = '0001';\nCOMMIT;" };
  assert.deepEqual(checkMigrations([good]), []);
  assert.match(checkMigrations([{ ...good, down: '' }]).join(' '), /has no down migration/);
  assert.match(checkMigrations([{ ...good, up: good.up.replace(/INSERT INTO schema_migrations[^\n]*\n/, '') }]).join(' '), /must record itself/);
  assert.match(checkMigrations([{ ...good, down: good.down.replace(/DELETE FROM schema_migrations[^\n]*\n/, '') }]).join(' '), /must remove its ledger row/);
  assert.match(checkMigrations([{ ...good, up: good.up.replace('BEGIN;\n', '') }]).join(' '), /BEGIN; \.\.\. COMMIT;/);
  assert.match(checkMigrations([{ ...good, version: '0002' }]).join(' '), /contiguous from 0001; expected 0001/);
  assert.match(checkMigrations([]).join(' '), /No migrations were found/);
});

test('every table the repository needs is created, and dropped by its own rollback', async () => {
  const migrations = await loadMigrations();
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]));
  for (const [table, version] of Object.entries(TABLES)) {
    const migration = byVersion.get(version);
    assert.ok(migration, `${table}: migration ${version} is missing`);
    assert.match(migration.up, new RegExp(`CREATE TABLE ${table} \\(`), `${table} is not created by ${version}`);
    assert.match(migration.down, new RegExp(`DROP TABLE IF EXISTS ${table};`), `${table} is not dropped by the ${version} rollback`);
  }
  // Nothing creates a table the list does not name, so the mapping stays honest in both directions.
  const created = migrations.flatMap(migration => [...migration.up.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(/g)].map(match => match[1]));
  assert.deepEqual(created.filter(table => !(table in TABLES)), ['schema_migrations']);
});

test('the retention rules and the lease are functions the adapter can call', async () => {
  const byVersion = new Map((await loadMigrations()).map(migration => [migration.version, migration]));
  const leases = byVersion.get('0008')!.up;
  // One statement, so two instances racing for the same key cannot both win.
  assert.match(leases, /CREATE FUNCTION huddle_acquire_lease/);
  assert.match(leases, /RETURNS SETOF sync_lease/, 'a refusal has to be no row, not a row of nulls');
  assert.match(leases, /WHERE lease\.owner = excluded\.owner OR lease\.expires_at <= p_now/);
  const retention = byVersion.get('0009')!.up;
  for (const rule of ['huddle_prune_league', 'huddle_prune_sessions', 'huddle_prune_sync_runs', 'huddle_prune_forecasts', 'huddle_prune_recommendations', 'huddle_prune_roster_history', 'huddle_apply_retention']) {
    assert.match(retention, new RegExp(`CREATE FUNCTION ${rule}\\(`), `${rule} is missing`);
  }
  // Pruning is only ever applied to an archived league nobody links; forcing it has to be explicit.
  assert.match(retention, /pruning requires an archived, unlinked league/);
});
