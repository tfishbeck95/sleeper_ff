import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eventually } from './support/process.mjs';
const engine = process.env.CONTAINER_ENGINE ?? 'docker';
const name = `huddle-test-db-${randomUUID().slice(0,8)}`;
const commands = [];
async function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...options }); commands.push(child);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
let owned = false;
async function cleanup() { for (const child of commands) if (child.exitCode === null) child.kill('SIGTERM'); if (owned) { owned = false; await run(engine, ['rm', '-f', name]); } }
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });
try {
  if (!process.env.E2E_DATABASE_URL) {
    const password = randomUUID();
    await run(engine, ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=huddle', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=huddle_e2e', '-p', '127.0.0.1::5432', 'postgres:17-alpine']); owned = true;
    let output = '';
    // Read the published random port with a separate capture, never changing the user's context.
    const port = await new Promise((resolve, reject) => {
      const c = spawn(engine, ['port', name, '5432/tcp']); c.stdout.on('data', b => { output += b; }); c.on('error', reject);
      c.on('exit', code => code === 0 ? resolve(output.trim().split(':').at(-1)) : reject(new Error('No database port')));
    });
    process.env.E2E_DATABASE_URL = `postgres://huddle:${password}@127.0.0.1:${port}/huddle_e2e`;
  }
  const { default: pg } = await import('pg');
  await eventually(async () => { const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL, connectionTimeoutMillis: 1_000 }); try { await c.connect(); await c.query('SELECT 1'); return true; } finally { await c.end(); } }, 60_000);
  await run('npm', ['run','build']);
  await run(process.execPath, ['--test','tests/contracts/sleeper.test.mjs']);
  await run(process.execPath, ['--import','tsx','--conditions=@sleeper/source','--test','tests/contracts/postgres.test.ts']);
  await run('npx', ['playwright','test', ...process.argv.slice(2)]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await cleanup(); }
