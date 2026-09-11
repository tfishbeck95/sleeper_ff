import { createRuntime, loadConfiguration, registerShutdown, startScheduledWork, type Component } from './runtime.js';
import { GracefulShutdown } from './shutdown.js';
import { logger } from './log.js';
import { startObservabilityServer } from './observability/server.js';

/**
 * The worker process.
 *
 * It owns every scheduled call to Sleeper and every housekeeping sweep, and serves no application
 * traffic. One of these runs per installation: the sweep lease would survive a second, but running one
 * on purpose is what keeps a free shared upstream API from being asked the same question twice.
 *
 * It is also the only process given the forecast credential, because it is the only one that calls the
 * forecast source. The API reads what this process retained.
 */

// This process binds no application port, so it is not asked for the settings that only mean
// something to a request — the trusted-proxy hop count chief among them.
const configuration = loadConfiguration(process.env, { servesHttp: false });
const runtime = createRuntime(configuration);
if (!configuration.sync.workerEnabled) {
  // Refusing is the honest answer: a worker container told not to run the schedule does nothing at all,
  // and an orchestrator would keep it running and healthy forever while no league is ever synchronized.
  logger.error({ component: 'worker' }, 'Refusing to start: SYNC_WORKER_ENABLED=false on the worker entrypoint, which would leave this process with nothing to do and no league synchronized.');
  process.exit(78);
}

const scheduled = startScheduledWork(runtime);
const components: Component[] = scheduled ? [scheduled] : [];

/**
 * The probes and the scrape, when a port is named for them.
 *
 * The worker binds no application port, which leaves an orchestrator with nothing to ask. This gives
 * it the same two answers the API gives — `/health/live` for "is the process responsive" and
 * `/health/ready` for "is its storage there" — and `/metrics` alongside them.
 *
 * They say the status and nothing else. The probe used to name the lease holder, which defaults to
 * `host:pid:random` — the container's hostname and process id, published by an endpoint with no
 * authentication in front of it. Which worker owns the schedule is a question for the logs and the
 * lease table, where it is already answered.
 *
 * `WORKER_HEALTH_PORT` and `METRICS_PORT` are both honoured, and one server serves whichever is
 * named: a deployment that already points a healthcheck at the first does not have to move it.
 */
const observabilityPort = configuration.metricsPort ?? configuration.workerHealthPort;
if (observabilityPort) {
  components.push(startObservabilityServer({ port: observabilityPort, readinessSource: runtime.store, log: logger }).component);
}

logger.info({ component: 'worker', owner: runtime.worker.owner }, 'schedule owned');
const shutdown = registerShutdown(new GracefulShutdown({ graceMs: configuration.shutdownGraceMs }), components, runtime);
shutdown.listen();
