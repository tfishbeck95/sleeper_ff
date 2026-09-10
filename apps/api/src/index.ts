import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SleeperClient } from '@sleeper/sleeper-client';
import { demoEnabled, validateAuthenticationConfig } from './auth.js';
import { createApp } from './app.js';
import { demoSnapshot } from './demo.js';
import { configureProjectionFeed } from './providers/index.js';
import { configureLeagueSyncWorker, syncWorkerEnabled } from './scheduler/index.js';
import { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';
import { PlayerDirectoryService } from './players.js';

validateAuthenticationConfig();
const store = new JsonStore(resolve(process.env.DATA_FILE ?? '../../data/store.json'));
const port = Number(process.env.PORT ?? 4000);
const interval = Number(process.env.SYNC_INTERVAL_MINUTES ?? 30) * 60_000;
if (process.env.APP_LOGIN_PASSWORD_HASH && !await store.applicationUserByLogin(process.env.APP_LOGIN_USER ?? 'admin')) {
  await store.saveApplicationUser({ id: randomUUID(), login: process.env.APP_LOGIN_USER ?? 'admin', passwordHash: process.env.APP_LOGIN_PASSWORD_HASH, sleeperLeagueIds: [], createdAt: new Date().toISOString() });
}
// The sample league is fiction, so it is seeded once here rather than synchronized: there is nothing
// upstream to synchronize it against. Production never reaches this line, and the worker never
// schedules the sample league even if a stored connection for it survives into a production store.
if (demoEnabled()) { await store.save(demoSnapshot()); console.info('[league-sync] sample league seeded'); }

const sleeper = new SleeperClient();
const sync = new LeagueSyncService(store, sleeper);
// One shared directory refreshes at most daily, even when there are no active leagues.
const players = new PlayerDirectoryService(store, sleeper);
const refreshPlayers = () => void players.refresh().catch(error => console.error('[players] storage failure', error));
const playerSweep = syncWorkerEnabled() ? setInterval(refreshPlayers, 60 * 60_000) : undefined;
if (playerSweep) { playerSweep.unref(); refreshPlayers(); }
/**
 * Connected leagues are synchronized by the worker, never by an interval in this file and never inside
 * an HTTP request. One instance owns the schedule: `SYNC_WORKER_ENABLED=false` opts an instance out
 * explicitly, and the sweep lease means that even a misconfigured fleet synchronizes each league once.
 * See docs/league-sync.md.
 */
const worker = configureLeagueSyncWorker(store, sync);
if (syncWorkerEnabled()) worker.start();
else console.info('[league-sync] schedule disabled on this instance; another worker or managed job owns it');

// The projection feed is opt-in: without PROJECTION_FEED_ENABLED nothing here starts, and the
// file-based WAIVER_SIGNALS_PATH adapter continues to serve forecasts exactly as before.
const projectionFeed = configureProjectionFeed(store);
projectionFeed?.schedule.start();
// Sessions that can no longer authenticate anything are swept on the sync cadence as well as at login,
// so an installation that is running but not being signed into does not accumulate them.
const sessionSweep = setInterval(() => void store.pruneSessions().catch(error => console.error('[sessions] prune failed', error)), Math.max(interval, 60 * 60_000));
sessionSweep.unref();
const server = createApp(store, sleeper, sync, projectionFeed?.store, worker).listen(port, () => console.info(`API listening on http://localhost:${port}`));
// A stopped worker holds no timer and takes no new leases; the ones it holds expire on their own, so a
// replacement instance picks the schedule up without waiting for anything to be released by hand.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  worker.stop(); projectionFeed?.schedule.stop(); clearInterval(sessionSweep); clearInterval(playerSweep);
  server.close(() => process.exit(0));
});
