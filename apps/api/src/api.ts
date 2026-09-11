import { createRuntime, loadConfiguration, registerShutdown, seed, startHttp } from './runtime.js';
import { GracefulShutdown } from './shutdown.js';

/**
 * The API process.
 *
 * It serves HTTP and runs no clocks. Everything scheduled — the league sweep, the player directory
 * refresh, session expiry, forecast ingestion — belongs to the worker, so this process can be scaled
 * to as many instances as the traffic needs without any of them duplicating the others' upstream calls.
 *
 * Run it with `SYNC_WORKER_ENABLED=false`, which is what makes the separation real rather than
 * implied; the sweep lease is the safety net for when it is forgotten, not the plan. See
 * docs/deployment.md.
 */

const configuration = loadConfiguration();
const runtime = createRuntime(configuration);
if (configuration.sync.workerEnabled) {
  console.warn('[api] SYNC_WORKER_ENABLED is not false, but this entrypoint runs no schedule. Set it false here and run the worker entrypoint, or run the combined entrypoint instead.');
}

await seed(runtime);
const { component } = startHttp(runtime);
const shutdown = registerShutdown(new GracefulShutdown({ graceMs: configuration.shutdownGraceMs }), [component], runtime);
shutdown.listen();
