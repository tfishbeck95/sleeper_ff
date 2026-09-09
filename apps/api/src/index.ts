import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateAuthenticationConfig } from './auth.js';
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
async function synchronize() { if (process.env.ENABLE_DEMO_AUTH === 'true') { await store.save(demoSnapshot()); console.info('[sync] demo league refreshed'); } }
await synchronize(); setInterval(() => void synchronize(), interval).unref();
createApp(store).listen(port, () => console.info(`API listening on http://localhost:${port}`));
