import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The migration set, as something the repository can check rather than a directory nobody reads.
 *
 * This never connects to a database. It answers the questions that are cheap to get wrong and
 * expensive to discover during a deployment: is every version paired with a rollback, are the versions
 * contiguous, and does each file record itself in the ledger so `schema_migrations` is the truth about
 * what has been applied.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface Migration { version: string; name: string; up: string; down: string }

const FILE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(directory)).filter(file => FILE.test(file)).sort();
  const migrations = new Map<string, Migration>();
  for (const file of files) {
    const [, version, name, direction] = FILE.exec(file)!;
    const migration = migrations.get(version) ?? { version, name, up: '', down: '' };
    migration[direction as 'up' | 'down'] = await readFile(`${directory}${file}`, 'utf8');
    migrations.set(version, migration);
  }
  return [...migrations.values()].sort((a, b) => a.version.localeCompare(b.version));
}

/** Returns one sentence per problem, and an empty array when the set is well formed. */
export function checkMigrations(migrations: Migration[]): string[] {
  const problems: string[] = [];
  if (!migrations.length) problems.push('No migrations were found.');
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (migration.version !== expected) problems.push(`${migration.version}_${migration.name}: versions must be contiguous from 0001; expected ${expected}.`);
    // A migration without a rollback is a migration that has to be right the first time.
    if (!migration.up.trim()) problems.push(`${migration.version}: has no up migration.`);
    if (!migration.down.trim()) problems.push(`${migration.version}: has no down migration.`);
    for (const [direction, sql] of [['up', migration.up], ['down', migration.down]] as const) {
      if (!sql.trim()) continue;
      // Each file opens its own transaction, so a failure leaves the database exactly as it was.
      if (!/^\s*BEGIN;/m.test(sql) || !/^\s*COMMIT;/m.test(sql)) problems.push(`${migration.version} ${direction}: must wrap its statements in BEGIN; ... COMMIT;.`);
    }
    const ledgerEntry = new RegExp(`INSERT INTO schema_migrations \\(version, name\\)\\s*VALUES \\('${migration.version}', '${migration.name}'\\)`);
    if (migration.up.trim() && !ledgerEntry.test(migration.up)) problems.push(`${migration.version} up: must record itself with INSERT INTO schema_migrations (version, name) VALUES ('${migration.version}', '${migration.name}').`);
    const ledgerRemoval = new RegExp(`DELETE FROM schema_migrations WHERE version = '${migration.version}'`);
    if (migration.down.trim() && !ledgerRemoval.test(migration.down)) problems.push(`${migration.version} down: must remove its ledger row with DELETE FROM schema_migrations WHERE version = '${migration.version}'.`);
  });
  return problems;
}
