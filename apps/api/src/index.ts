import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { demoEnabled, validateAuthenticationConfig } from './auth.js';
import { createApp } from './app.js';
import { demoSnapshot } from './demo.js';
import { JsonStore } from './store.js';

validateAuthenticationConfig();
const store = new JsonStore(resolve(process.env.DATA_FILE ?? '../../data/store.json'));
const port = Number(process.env.PORT ?? 4000);
const interval = Number(process.env.SYNC_INTERVAL_MINUTES ?? 30) * 60_000;
if (process.env.APP_LOGIN_PASSWORD_HASH && !await store.applicationUserByLogin(process.env.APP_LOGIN_USER ?? 'admin')) {
  await store.saveApplicationUser({ id: randomUUID(), login: process.env.APP_LOGIN_USER ?? 'admin', passwordHash: process.env.APP_LOGIN_PASSWORD_HASH, sleeperLeagueIds: [], createdAt: new Date().toISOString() });
}
async function synchronize() { if (demoEnabled()) { await store.save(demoSnapshot()); console.info('[sync] demo league refreshed'); } }
await synchronize(); setInterval(() => void synchronize(), interval).unref();
// Sessions that can no longer authenticate anything are swept on the sync cadence as well as at login,
// so an installation that is running but not being signed into does not accumulate them.
setInterval(() => void store.pruneSessions().catch(error => console.error('[sessions] prune failed', error)), Math.max(interval, 60 * 60_000)).unref();
createApp(store).listen(port, () => console.info(`API listening on http://localhost:${port}`));
