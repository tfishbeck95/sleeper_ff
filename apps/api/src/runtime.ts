import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { SleeperClient } from '@sleeper/sleeper-client';
import { createApp } from './app.js';
import { demoSnapshot } from './demo.js';
import { describeEnvironment, validateEnvironment, type RuntimeConfiguration } from './config/environment.js';
import { PlayerDirectoryService } from './players.js';
import { configureProjectionFeed, configureProjectionFeedReader, type ProjectionFeedStore } from './providers/index.js';
import { configureLeagueSyncWorker, type LeagueSyncWorker } from './scheduler/index.js';
import { closeHttpServer, GracefulShutdown } from './shutdown.js';
import { createRepository, describeStorage, type HuddleRepository } from './storage/index.js';
import { LeagueSyncService } from './sync.js';

/**
 * What both processes are built from.
 *
 * The API and the worker are two entrypoints over one application: they validate the same environment,
 * talk to the same storage, and share the same domain services. What differs is what they *start* —
 * the API binds a port and runs no clocks, the worker runs every clock and binds nothing but a health
 * probe — and keeping that difference in two short files over one composition root is what stops them
 * drifting into two applications that happen to share a database.
 *
 * Splitting them is not an optimization. The worker is the process allowed to call Sleeper on a
 * schedule, and `SYNC_WORKER_ENABLED=false` on the API instances is what makes "one worker owns the
 * schedule" a deployment fact rather than a hope. It also separates the secrets: only the worker is
 * given the forecast credential, because only the worker calls the source. The API reads the feed the
 * worker retained and never needs the key at all.
 */

export interface Runtime {
  configuration: RuntimeConfiguration;
  store: HuddleRepository;
  sleeper: SleeperClient;
  sync: LeagueSyncService;
  players: PlayerDirectoryService;
  worker: LeagueSyncWorker;
}

/**
 * Validates the environment and returns what to build, or reports every problem and exits.
 *
 * Exiting here rather than throwing keeps the failure readable: an `EnvironmentError` thrown out of an
 * entrypoint is a stack trace wrapped around a list whose first line nobody sees. The status is 78,
 * `EX_CONFIG` — an orchestrator that restarts on failure restarts this forever, and the code says why
 * before anyone reads the logs.
 */
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): RuntimeConfiguration {
  let configuration: RuntimeConfiguration;
  try { configuration = validateEnvironment(env); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(78); }
  console.info(`[config] ${describeEnvironment(configuration)}`);
  console.info(`[storage] ${describeStorage(configuration.storage)}`);
  if (configuration.storage.defaulted) console.info('[storage] STORAGE_ADAPTER is unset; using the local JSON adapter. Production requires it to be named explicitly.');
  for (const warning of configuration.warnings) console.warn(`[config] ${warning}`);
  return configuration;
}

/**
 * Builds the services. Starts nothing: what runs is the entrypoint's decision.
 *
 * A storage configuration that is valid but cannot be served — `STORAGE_ADAPTER=postgres`, which has a
 * schema and no adapter behind it yet — is reported the same way a bad environment is, with the
 * adapter's own message and `EX_CONFIG`, rather than as an unhandled rejection at the top of an
 * entrypoint. An orchestrator restarting on that loop should be able to read why from one line.
 */
export function createRuntime(configuration: RuntimeConfiguration): Runtime {
  let store: HuddleRepository;
  try { ({ repository: store } = createRepository()); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(78); }
  const sleeper = new SleeperClient();
  const sync = new LeagueSyncService(store, sleeper);
  const players = new PlayerDirectoryService(store, sleeper);
  const worker = configureLeagueSyncWorker(store, sync);
  return { configuration, store, sleeper, sync, players, worker };
}

/**
 * Seeds the account and the sample league that exist only because configuration asked for them.
 *
 * The API does this, not the worker: the configured login exists to be signed in to and the sample
 * league exists to be served, and having one process own the writes keeps two from racing to create
 * the same account.
 */
export async function seed({ store, configuration }: Runtime, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const login = env.APP_LOGIN_USER ?? 'admin';
  if (env.APP_LOGIN_PASSWORD_HASH && !await store.applicationUserByLogin(login)) {
    await store.saveApplicationUser({ id: randomUUID(), login, passwordHash: env.APP_LOGIN_PASSWORD_HASH, sleeperLeagueIds: [], createdAt: new Date().toISOString() });
  }
  // The sample league is fiction, so it is seeded once here rather than synchronized: there is nothing
  // upstream to synchronize it against. Production never reaches this line, and the worker never
  // schedules the sample league even if a stored connection for it survives into a production store.
  if (configuration.demoEnabled) { await store.save(demoSnapshot()); console.info('[league-sync] sample league seeded'); }
}

/**
 * One half of the process: something that can stop taking new work, and something that can wait for
 * the work it already has.
 *
 * They are separate because the order across the whole process matters more than the order within one
 * component. Everything stops first, then everything drains. Draining the HTTP server while the sweep
 * is still queueing leagues would mean waiting on work that is still arriving — with the grace period
 * running — which is how a graceful shutdown becomes a timeout.
 */
export interface Component {
  /** Stops accepting new work. Returns promptly; it never waits for what is in flight. */
  stop(): void | Promise<void>;
  /** Waits for the work already started to finish. */
  drain(): void | Promise<void>;
}

/**
 * Binds the port.
 *
 * The forecast reader is the retained feed and nothing else — no provider, no credential. An API
 * instance serves advice from the snapshot the worker wrote and never calls the source itself, so the
 * subscription key does not belong in its environment.
 *
 * The manual-refresh endpoint hands work to the worker object even on an instance whose schedule is
 * disabled — that is what makes a refresh a queued job rather than seven upstream calls held open
 * inside someone's request — so an API instance can have synchronizations in flight, and drains them
 * on the way out like the worker does.
 */
export function startHttp(runtime: Runtime, reader: ProjectionFeedStore | null = configureProjectionFeedReader()): { server: Server; component: Component } {
  const { configuration, store, sleeper, sync, worker } = runtime;
  const app = createApp(store, sleeper, sync, reader ?? undefined, worker);
  const server = app.listen(configuration.port, () => console.info(`[api] listening on port ${configuration.port}`));
  return {
    server,
    component: {
      // `/health` is already answering 503 by the time this runs, so a load balancer has had its
      // chance to take this instance out of rotation before the listener closes.
      stop: () => closeHttpServer(server, configuration.shutdownGraceMs),
      drain: () => worker.settled(),
    },
  };
}

/**
 * Starts everything that runs on a clock.
 *
 * All of it is gated on owning the schedule, for the same reason the league sweep is: these are
 * whole-installation housekeeping jobs, not per-instance ones. A fleet of API instances each expiring
 * the same sessions and refreshing the same player directory is the duplicated work the worker exists
 * to stop. Returns null on an instance that owns none of it.
 */
export function startScheduledWork(runtime: Runtime): Component | null {
  const { configuration, store, players, worker } = runtime;
  if (!configuration.sync.workerEnabled) {
    console.info('[league-sync] schedule disabled on this instance; another worker or managed job owns it');
    return null;
  }

  // One shared directory refreshes at most daily, even when there are no active leagues.
  const refreshPlayers = () => void players.refresh().catch(error => console.error('[players] storage failure', error));
  const playerSweep = setInterval(refreshPlayers, 60 * 60_000);
  playerSweep.unref();
  refreshPlayers();

  /**
   * Connected leagues are synchronized by the worker, never by an interval and never inside an HTTP
   * request. One instance owns the schedule: `SYNC_WORKER_ENABLED=false` opts an instance out
   * explicitly, and the sweep lease means that even a misconfigured fleet synchronizes each league
   * once. See docs/league-sync.md.
   */
  worker.start();

  // The projection feed is opt-in: without PROJECTION_FEED_ENABLED nothing here starts, and the
  // file-based WAIVER_SIGNALS_PATH adapter continues to serve forecasts exactly as before.
  const projectionFeed = configureProjectionFeed(store);
  projectionFeed?.schedule.start();

  // Sessions that can no longer authenticate anything are swept on the sync cadence as well as at
  // login, so an installation that is running but not being signed into does not accumulate them.
  const sessionSweep = setInterval(() => void store.pruneSessions().catch(error => console.error('[sessions] prune failed', error)), Math.max(configuration.sync.intervalMs, 60 * 60_000));
  sessionSweep.unref();

  return {
    // A stopped worker holds no timer and takes no new leases; the sweep already running keeps its own
    // until it finishes, which is what `drain` waits for.
    stop: () => {
      worker.stop();
      projectionFeed?.schedule.stop();
      clearInterval(playerSweep);
      clearInterval(sessionSweep);
    },
    drain: async () => {
      // Waiting for the sweep means its leases are released rather than left for a replacement
      // instance to wait out, and an ingestion seconds from finishing is not thrown away.
      await worker.settled();
      await projectionFeed?.schedule.settled();
    },
  };
}

/**
 * Registers the shutdown sequence: stop everything, drain everything, then put the storage down.
 *
 * The storage handle is closed last because a repository method called after it may fail — and both
 * draining a synchronization and releasing a lease are repository methods.
 */
export function registerShutdown(shutdown: GracefulShutdown, components: readonly Component[], runtime: Runtime): GracefulShutdown {
  shutdown.add('stop accepting new work', async () => { for (const component of components) await component.stop(); });
  shutdown.add('finish the work already in flight', async () => { for (const component of components) await component.drain(); });
  shutdown.add('close the storage handle', () => runtime.store.close?.());
  return shutdown;
}
