import { createServer } from 'node:http';
import { createRuntime, loadConfiguration, registerShutdown, startScheduledWork, type Component } from './runtime.js';
import { closeHttpServer, GracefulShutdown } from './shutdown.js';
import { isDraining } from './lifecycle.js';

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

const configuration = loadConfiguration();
const runtime = createRuntime(configuration);
if (!configuration.sync.workerEnabled) {
  // Refusing is the honest answer: a worker container told not to run the schedule does nothing at all,
  // and an orchestrator would keep it running and healthy forever while no league is ever synchronized.
  console.error('Refusing to start: SYNC_WORKER_ENABLED=false on the worker entrypoint, which would leave this process with nothing to do and no league synchronized.');
  process.exit(78);
}

const scheduled = startScheduledWork(runtime);
const components: Component[] = scheduled ? [scheduled] : [];

/**
 * A liveness probe, when one is asked for.
 *
 * The worker binds no port of its own, which leaves an orchestrator with nothing to ask. This is the
 * smallest thing that answers: it reports that the process is up and whether it has begun draining. It
 * is off unless `WORKER_HEALTH_PORT` names a port, so a worker on a host that already has something on
 * that port is not forced to take it.
 */
if (configuration.workerHealthPort) {
  const probe = createServer((request, response) => {
    if (request.url !== '/health') { response.writeHead(404).end(); return; }
    const body = JSON.stringify(isDraining() ? { status: 'shutting-down', worker: runtime.worker.owner } : { status: 'ok', worker: runtime.worker.owner });
    response.writeHead(isDraining() ? 503 : 200, { 'Content-Type': 'application/json' }).end(body);
  });
  probe.listen(configuration.workerHealthPort, () => console.info(`[worker] health probe on port ${configuration.workerHealthPort}`));
  components.push({ stop: () => closeHttpServer(probe, configuration.shutdownGraceMs), drain: () => undefined });
}

console.info(`[worker] schedule owned by ${runtime.worker.owner}`);
const shutdown = registerShutdown(new GracefulShutdown({ graceMs: configuration.shutdownGraceMs }), components, runtime);
shutdown.listen();
