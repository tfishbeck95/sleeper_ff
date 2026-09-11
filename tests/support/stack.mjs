import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { scryptSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { database } from './database.mjs';
import { sleeperServer } from './sleeper-server.mjs';
import { scenario } from './scenarios.mjs';
import pg from 'pg';
import { PostgresStore } from '../../apps/api/dist/storage/postgres.js';
export const PASSWORD = 'fixture-password-only';
const hash = `scrypt:0123456789abcdef:${scryptSync(PASSWORD, '0123456789abcdef', 64).toString('hex')}`;
const root = resolve('.');
import { eventually } from './process.mjs';
export { eventually };
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
export async function stack() {
  const db = await database('browser'); const upstream = await sleeperServer();
  const directory = await mkdtemp(join(tmpdir(), 'huddle-e2e-'));
  const store = new PostgresStore(db.url); const processes = new Map(); const logs = {};
  let web;
  const apiPort = await port(), workerPort = await port(), webPort = await port();
  const url = `https://127.0.0.1:${webPort}`, apiUrl = `http://127.0.0.1:${apiPort}`;
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(apiPort), WEB_ORIGIN: url, TRUST_PROXY: 'loopback',
    STORAGE_ADAPTER: 'postgres', APP_INSTANCE_MODE: 'multi', DATABASE_URL: db.url,
    APP_LOGIN_USER: 'owner', APP_LOGIN_PASSWORD_HASH: hash, INSECURE_DEV_COOKIES: 'false', ENABLE_DEMO_AUTH: 'false',
    SLEEPER_API_BASE_URL: upstream.url, SYNC_JITTER_SECONDS: '0', SYNC_INTERVAL_MINUTES: '1', SYNC_RETRY_BASE_SECONDS: '1',
    UPSTREAM_TIMEOUT_SECONDS: '1', UPSTREAM_MAX_ATTEMPTS: '3', UPSTREAM_REQUEST_BUDGET_SECONDS: '3',
    UPSTREAM_BACKGROUND_BUDGET_SECONDS: '3', WORKER_HEALTH_PORT: String(workerPort),
    WAIVER_SIGNALS_PATH: join(directory, 'forecast.json'), PROJECTION_FEED_ENABLED: 'false', LOG_LEVEL: 'warn' };
  const forecast = async mode => {
    if (mode === 'missing') { await rm(env.WAIVER_SIGNALS_PATH, { force: true }); return; }
    const f = scenario().forecast;
    if (mode === 'stale') f.updatedAt = '2020-01-01T00:00:00.000Z';
    if (mode === 'partial') f.players = f.players.slice(0, 1);
    await writeFile(`${env.WAIVER_SIGNALS_PATH}.tmp`, mode === 'malformed' ? '{broken-json' : JSON.stringify(f));
    await rename(`${env.WAIVER_SIGNALS_PATH}.tmp`, env.WAIVER_SIGNALS_PATH);
  };
  const start = async role => {
    logs[role] = '';
    const roleEnv = { ...env, SYNC_WORKER_ENABLED: String(role === 'worker'), SYNC_WORKER_ID: `test-${role}-${randomUUID()}` };
    if (role === 'worker') for (const key of ['APP_LOGIN_USER', 'APP_LOGIN_PASSWORD_HASH', 'WEB_ORIGIN', 'TRUST_PROXY']) delete roleEnv[key];
    const child = spawn(process.execPath, [`apps/api/dist/${role}.js`], { cwd: root, env: roleEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.set(role, child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs[role] = (logs[role] + b.toString()).slice(-30_000); });
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`${role} exited ${child.exitCode}: ${logs[role]}`);
      return (await fetch(`${role === 'api' ? apiUrl : `http://127.0.0.1:${workerPort}`}/health/ready`)).ok;
    });
  };
  const stop = async (role, signal = 'SIGTERM') => {
    const child = processes.get(role); if (!child || child.exitCode !== null || child.signalCode) return;
    const ended = once(child, 'exit'); child.kill(signal);
    let timer; try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${role} failed to drain`)); }, 25_000); })]); }
    finally { clearTimeout(timer); processes.delete(role); }
  };
  const close = async () => { await Promise.all([...processes.keys()].map(r => stop(r))); if (web) { web.closeAllConnections(); await new Promise(r => web.close(r)); } await upstream.close(); await store.close(); await db.close(); await rm(directory, { recursive: true, force: true }); };
  try {
    await forecast('fresh');
    // Accounts are fixtures, but authentication itself uses the real password and session code.
    for (const login of ['owner', 'coowner', 'stranger']) await store.saveApplicationUser({ id: randomUUID(), login, passwordHash: hash, sleeperLeagueIds: [], createdAt: new Date().toISOString() });
    await start('api'); await start('worker');
    // Serve only compiled Vite output, and proxy the API on the browser's origin. No Vite dev server,
    // browser route interception, source imports, or mock application endpoints are involved.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    web = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, async (req, res) => {
      if (/^\/(api\/|auth\/|health)/.test(req.url)) {
        const proxy = request(`${apiUrl}${req.url}`, { method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
        proxy.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(proxy); return;
      }
      try {
        const pathname = new URL(req.url, url).pathname;
        const file = pathname.startsWith('/assets/') ? resolve(root, 'apps/web/dist', `.${pathname}`) : resolve(root, 'apps/web/dist/index.html');
        if (!file.startsWith(resolve(root, 'apps/web/dist') + '/') || file.endsWith('.map')) { res.writeHead(404); res.end(); return; }
        const content = await readFile(file);
        res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-cache' }); res.end(content);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => web.listen(webPort, '127.0.0.1', r));
    const expireLeases = async () => {
      const client = new pg.Client({ connectionString: db.url }); await client.connect();
      try { await client.query("UPDATE sync_lease SET acquired_at = now() - interval '11 minutes', expires_at = now() - interval '1 second'"); }
      finally { await client.end(); }
    };
    return { expireLeases, url, apiUrl, workerUrl: `http://127.0.0.1:${workerPort}`, store, upstream, forecast, logs, start, stop, close };
  } catch (error) { await close(); throw error; }
}
