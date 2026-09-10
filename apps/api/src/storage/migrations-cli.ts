import { checkMigrations, loadMigrations, MIGRATIONS_DIR } from './migrations.js';

/** A lint over the migration set. It never connects to a database; `migrations/verify/run.sh` does. */
const migrations = await loadMigrations();
const problems = checkMigrations(migrations);
if (problems.length) {
  console.error(`${MIGRATIONS_DIR}: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.info(`${migrations.length} migrations, each with a rollback and a ledger entry:`);
for (const migration of migrations) console.info(`  ${migration.version} ${migration.name}`);
