import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const migrationDirectory = resolve('apps/api/migrations');
export async function migrate(url, directory = migrationDirectory, through = '9999') {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(778811223344)');
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0].present;
    const applied = new Set(exists ? (await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version) : []);
    for (const file of (await readdir(directory)).filter(f => /^\d{4}_.*\.up\.sql$/.test(f)).sort()) {
      const version = file.slice(0, 4);
      if (version <= through && !applied.has(version)) await client.query(await readFile(resolve(directory, file), 'utf8'));
    }
  } finally { await client.end(); }
}
// Never drop/reset the supplied database. Each test owns a newly created, randomly named database.
export async function database(label = 'suite', { migrateNow = true } = {}) {
  if (!process.env.E2E_DATABASE_URL) throw new Error('E2E_DATABASE_URL must point to an isolated PostgreSQL 17 test server.');
  const name = `huddle_test_${label.replace(/[^a-z0-9]/g, '')}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const uri = new URL(process.env.E2E_DATABASE_URL); uri.pathname = `/${name}`;
  const url = uri.toString();
  const close = async () => {
    const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }); await client.connect();
    try { await client.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await client.end(); }
  };
  try { if (migrateNow) await migrate(url); } catch (error) { await close(); throw error; }
  return { url, close };
}
