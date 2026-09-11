import { createRuntime, loadConfiguration, registerShutdown, seed, startHttp, startObservability, startScheduledWork, type Component } from './runtime.js';
import { GracefulShutdown } from './shutdown.js';

/**
 * The combined process: the API and the schedule in one.
 *
 * This is what `npm run dev` runs and what a single-container deployment runs, and it is the right
 * shape for an installation with one instance — there is nothing to coordinate, so there is no reason
 * to run two processes. Scaling past one instance means running `api.ts` on each of them with
 * `SYNC_WORKER_ENABLED=false` and `worker.ts` once. See docs/deployment.md.
 */

const configuration = loadConfiguration();
const runtime = createRuntime(configuration);
await seed(runtime);

// HTTP stops first so the load balancer sees a draining instance before the clocks stop; the schedule
// is stopped in the same phase, and only then is anything waited for.
const { component: http } = startHttp(runtime);
const scheduled = startScheduledWork(runtime);
const observability = startObservability(runtime);
const components: Component[] = [http, ...(scheduled ? [scheduled] : []), ...(observability ? [observability] : [])];
const shutdown = registerShutdown(new GracefulShutdown({ graceMs: configuration.shutdownGraceMs }), components, runtime);
shutdown.listen();
