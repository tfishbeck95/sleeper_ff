import { createServer, type Server } from 'node:http';
import { logger, type Logger } from '../log.js';
import { closeHttpServer } from '../shutdown.js';
import type { Component } from '../runtime.js';
import { liveness, readiness, type Readiness } from './health.js';
import { registry } from './metrics.js';

/**
 * The probe and scrape port, which is deliberately not the application's.
 *
 * `/metrics` is an operational disclosure: route names, traffic volumes, error rates, how many
 * leagues are connected, when the last synchronization succeeded. None of it is a credential and all
 * of it is a description of the deployment, which is exactly the class of thing that should not be
 * reachable from the internet. Putting it on its own port is what lets it be bound to an internal
 * network or a sidecar rather than protected by a token that ends up in a scrape configuration in a
 * repository somewhere.
 *
 * It is off unless a port is named, so nothing is exposed by upgrading.
 *
 * The probes are served here as well as on the API, because the worker has no API to serve them on
 * and an orchestrator needs the same two answers from both processes.
 */

export interface ObservabilityServerOptions {
  port: number;
  /** Present on a process that has storage; the worker and the API both do. */
  readinessSource?: Parameters<typeof readiness>[0];
  log?: Logger;
}

const json = (body: unknown) => JSON.stringify(body);

export function startObservabilityServer({ port, readinessSource, log = logger }: ObservabilityServerOptions): { server: Server; component: Component } {
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }).end(json(body));
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }

    if (path === '/health/live') return send(200, liveness());
    // The original probe, kept because a running deployment's healthcheck is pointed at it. It is
    // readiness, which is what it has always meant.
    if (path === '/health/ready' || path === '/health') {
      if (!readinessSource) return send(200, { status: 'ready', checks: [] } satisfies Readiness);
      void readiness(readinessSource)
        .then(result => send(result.status === 'ready' ? 200 : 503, result))
        // A readiness probe that throws is not ready. Answering 503 is the correct report of that,
        // and is what keeps a broken probe from looking like a healthy instance.
        .catch(() => send(503, { status: 'not-ready', checks: [{ name: 'storage', ok: false }] } satisfies Readiness));
      return;
    }
    if (path === '/metrics') {
      void registry.render()
        .then(body => {
          response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
        })
        .catch(error => { log.error({ component: 'metrics', error }, 'metrics render failed'); response.writeHead(500).end(); });
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(json({ error: 'Not found.' }));
  });

  server.listen(port, () => log.info({ component: 'observability', port }, 'metrics and probes listening'));
  return {
    server,
    component: { stop: () => closeHttpServer(server, 5_000), drain: () => undefined },
  };
}
