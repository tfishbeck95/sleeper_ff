import { createServer } from 'node:http';
import { createRuntime, loadConfiguration, registerShutdown, startScheduledWork, type Component } from './runtime.js';
import { closeHttpServer, GracefulShutdown } from './shutdown.js';
import { isDraining } from './lifecycle.js';
import { logger } from './log.js';

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
 * A liveness probe, when one is asked for.
 *
 * The worker binds no port of its own, which leaves an orchestrator with nothing to ask. This is the
 * smallest thing that answers: it reports that the process is up and whether it has begun draining. It
 * is off unless `WORKER_HEALTH_PORT` names a port, so a worker on a host that already has something on
 * that port is not forced to take it.
 *
 * The answer is the status and nothing else. It used to name the lease holder, which defaults to
 * `host:pid:random` — the container's hostname and process id, published by an endpoint that has no
 * authentication in front of it. Which worker holds the schedule is a question for the logs and the
 * lease table, where it is already answered; a probe only has to say whether to keep routing here.
 */
if (configuration.workerHealthPort) {
  const probe = createServer((request, response) => {
    if (request.url !== '/health') { response.writeHead(404).end(); return; }
    const draining = isDraining();
    response.writeHead(draining ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      .end(JSON.stringify({ status: draining ? 'shutting-down' : 'ok' }));
  });
  probe.listen(configuration.workerHealthPort, () => logger.info({ component: 'worker', port: configuration.workerHealthPort }, 'health probe listening'));
  components.push({ stop: () => closeHttpServer(probe, configuration.shutdownGraceMs), drain: () => undefined });
}

logger.info({ component: 'worker', owner: runtime.worker.owner }, 'schedule owned');
const shutdown = registerShutdown(new GracefulShutdown({ graceMs: configuration.shutdownGraceMs }), components, runtime);
shutdown.listen();
