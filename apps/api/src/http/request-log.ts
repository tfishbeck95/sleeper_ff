import { randomUUID } from 'node:crypto';
import type express from 'express';
import type { Authentication } from '../auth.js';
import { identify, type Logger } from '../log.js';
import { httpDuration, httpInFlight, httpRequests } from '../observability/instruments.js';
import { routeOf } from './errors.js';

/**
 * An identifier for one request, and one line about it when it finishes.
 *
 * The id is the thing that makes the rest of the logging worth having. A failure produces a line
 * here, a line from the terminal handler and possibly a line from a synchronization three layers
 * down; without a shared id those are three unrelated entries in a stream carrying thousands, and
 * the only way to connect them is a timestamp and hope. It is also returned to the caller, in the
 * response header and in the body of every failure, so a bug report can name the exact request.
 *
 * An inbound `X-Request-Id` is honoured so a trace started at the load balancer survives into these
 * logs — but only after it is checked. The value is written into log lines and echoed in a response
 * header, so an unchecked one is a caller choosing what appears in both. A newline in a header value
 * is a response-splitting attempt; a kilobyte of text in one is a log the caller is writing.
 *
 * What the access line deliberately does not carry:
 *
 * - **The path.** The *route pattern* is logged instead — `/api/dashboard/:leagueId` rather than
 *   `/api/dashboard/1234` — which is what makes the field aggregatable and keeps identifiers out of
 *   a log that is usually shipped somewhere else.
 * - **The query string.** It holds the week, the trade bounds and a name search. The names of the
 *   parameters are enough to debug a rejected request; the values are the caller's.
 * - **Anything identifying.** The account and the session are recorded as digests, so two lines can
 *   be joined without either naming who they are about.
 */

/** Bounded, single-line, and drawn from an alphabet that cannot terminate a header. */
const ACCEPTABLE_ID = /^[A-Za-z0-9_.:-]{8,64}$/;

export function requestId(): express.RequestHandler {
  return (req, res, next) => {
    const supplied = req.header('x-request-id');
    const id = supplied && ACCEPTABLE_ID.test(supplied) ? supplied : randomUUID();
    res.locals.requestId = id;
    // Echoed early, so it is present on a response written by any layer — including one that fails
    // before reaching a route.
    res.set('X-Request-Id', id);
    next();
  };
}

/** The client address as the rate limiters see it, which is only the real client behind a correctly configured proxy. */
const addressOf = (req: express.Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export interface AccessLogOptions {
  /** Paths that are not worth a line each. The orchestrator's probe is every thirty seconds, forever. */
  quiet?: (req: express.Request) => boolean;
  now?: () => number;
}

/**
 * One line per finished request.
 *
 * It is written on `finish` rather than at the end of the handler so that the status and the byte
 * count are the ones actually sent, and on `close` so that a request the client abandoned — which is
 * how a timeout looks from here — is recorded rather than lost.
 */
export function accessLog(log: Logger, { quiet, now = () => Date.now() }: AccessLogOptions = {}): express.RequestHandler {
  return (req, res, next) => {
    const started = now();
    httpInFlight.inc();
    let written = false;
    const write = (aborted: boolean) => {
      if (written) return;
      written = true;
      httpInFlight.dec();
      const route = routeOf(req);
      const durationSeconds = (now() - started) / 1000;
      // Measured for every request including the quiet ones: a probe that starts timing out is
      // exactly the thing worth seeing, and it is the request that never appears in a log.
      // The status is recorded as a *class*, so the label stays a closed set of four values.
      httpRequests.inc({ route, method: req.method, status: `${Math.floor(res.statusCode / 100)}xx` });
      httpDuration.observe({ route, method: req.method }, durationSeconds);
      if (quiet?.(req)) return;
      const auth = res.locals.auth as Authentication | undefined;
      const fields = {
        requestId: res.locals.requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: now() - started,
        ip: addressOf(req),
        // Digests rather than names: enough to correlate one account's requests, not enough to say
        // whose. `familyId` survives session rotation, so a session stays one session in the logs.
        account: identify(auth?.user.id),
        session: identify(auth?.session.familyId),
        // The parameters the caller supplied, without what they supplied in them.
        queryKeys: Object.keys(req.query).slice(0, 10),
        ...(aborted ? { aborted: true } : {}),
      };
      // A 5xx is already reported by the terminal handler at error level; repeating it here would
      // double every incident. This line is the record that the request happened.
      if (res.statusCode >= 500 || aborted) log.warn(fields, 'request completed');
      else log.info(fields, 'request completed');
    };
    res.on('finish', () => write(false));
    res.on('close', () => write(!res.writableEnded));
    next();
  };
}

/** The identity fields any other log line in a request's lifetime should carry. */
export const requestFields = (res: express.Response) => ({ requestId: res.locals.requestId });
