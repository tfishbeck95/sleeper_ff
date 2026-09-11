import type express from 'express';
import { SleeperApiError } from '@sleeper/sleeper-client';
import { DashboardAccessError } from '../command-center.js';
import { ProviderFetchError } from '../providers/http.js';
import type { Logger } from '../log.js';

/**
 * What the client is told when something fails, and what only the logs are told.
 *
 * The distinction this module exists to draw is between *the caller asked for something impossible*
 * and *we could not do it*. Collapsing them is how an API ends up reporting its own bugs as an
 * upstream outage — the previous terminal handler answered 502 "Sleeper is unavailable" to a
 * `TypeError` thrown in our own code, which sends an operator to look at someone else's status page
 * and tells a monitor to page the wrong team.
 *
 * Three rules decide every answer here:
 *
 * 1. **A 4xx is the caller's to fix, so it says what to fix.** Those messages are ours — fixed
 *    strings written in this repository — never an upstream's message and never the value that was
 *    rejected, because echoing a request back into a response is how a reflected payload finds a
 *    client that renders it.
 * 2. **A 5xx is ours, so it says nothing.** The class ("a dependency failed", "unexpected") and the
 *    request id are enough for a person to open a ticket with; the message, the stack and the failing
 *    path stay in the log.
 * 3. **An upstream's 4xx is not the caller's 4xx.** Sleeper answering 400 or 403 means we built a bad
 *    request or lost our access. That is a 502: the caller did nothing wrong and retrying with
 *    different input will not help them. The one exception is 404, which genuinely means the league
 *    or user the caller named does not exist upstream.
 */

/** An error that already knows its status. Anything a route refuses deliberately is one of these. */
export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  readonly retryAfterSeconds?: number;
  readonly code?: string;
  constructor(status: number, message: string, options: { code?: string; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    // A message is shown to the caller only when the status says the caller can act on it.
    this.expose = status < 500;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const badRequest = (message: string, code?: string) => new HttpError(400, message, { code });
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);
export const payloadTooLarge = (message: string) => new HttpError(413, message);
export const unsupportedMediaType = (message: string) => new HttpError(415, message);
export const tooManyRequests = (message: string, retryAfterSeconds: number) => new HttpError(429, message, { retryAfterSeconds });

export interface Classification {
  status: number;
  /** The body's `error`. Always a string this repository wrote. */
  message: string;
  /** A stable machine-readable class, so a client can branch without parsing prose. */
  code: string;
  retryAfterSeconds?: number;
  /** Whether the failure is worth waking someone for. 5xx is; a rejected query is not. */
  level: 'warn' | 'error';
}

/** `body-parser` reports its refusals by `type`, which is the only stable thing about them. */
interface BodyParserError extends Error { type?: string; status?: number; statusCode?: number }
const bodyParserType = (error: unknown): string | undefined =>
  typeof (error as BodyParserError)?.type === 'string' && ((error as BodyParserError).status ?? (error as BodyParserError).statusCode) !== undefined
    ? (error as BodyParserError).type : undefined;

/**
 * The class a caller branches on when a refusal carries no more specific one.
 *
 * A body that says `bad_request` for a 404 and for a 429 alike is a body a client has to ignore in
 * favour of the status — which is the whole reason the field exists.
 */
function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 405: return 'method_not_allowed';
    case 409: return 'conflict';
    case 413: return 'body_too_large';
    case 415: return 'unsupported_media_type';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'internal' : 'bad_request';
  }
}

const UPSTREAM_UNAVAILABLE = 'The data source this request depends on is unavailable. Try again shortly.';
const UPSTREAM_FAILED = 'The data source this request depends on failed. Try again shortly.';
const UNEXPECTED = 'The request could not be completed.';

/**
 * Maps an upstream failure onto what the caller should do about it.
 *
 * The two upstream clients categorize failures identically on purpose (see `config/upstream.ts`), so
 * one table covers both: what differs is only which source is named in the log.
 */
function classifyUpstream(category: string, retryAfterSeconds?: number): Classification {
  switch (category) {
    // The thing the caller named is not there. The only upstream status the caller can act on.
    case 'not_found':
      return { status: 404, message: 'The requested league, user or resource does not exist upstream.', code: 'upstream_not_found', level: 'warn' };
    // Upstream is throttling *us*. The caller is not over any budget of theirs, so this is a
    // temporary unavailability with a hint, not a 429 that would blame them for our quota.
    case 'rate_limit':
      return { status: 503, message: UPSTREAM_UNAVAILABLE, code: 'upstream_rate_limited', retryAfterSeconds: retryAfterSeconds ?? 30, level: 'error' };
    case 'timeout':
      return { status: 504, message: 'The data source this request depends on did not answer in time. Try again shortly.', code: 'upstream_timeout', level: 'error' };
    // Our credential, our problem. The caller must never be able to tell an expired subscription key
    // from an outage: one of those is a fact about our deployment.
    case 'unauthorized':
      return { status: 502, message: UPSTREAM_FAILED, code: 'upstream_failed', level: 'error' };
    case 'network': case 'server':
      return { status: 502, message: UPSTREAM_UNAVAILABLE, code: 'upstream_unavailable', level: 'error' };
    // A 4xx we caused, or a body that did not validate. Both are defects here, not there.
    case 'client': case 'validation': default:
      return { status: 502, message: UPSTREAM_FAILED, code: 'upstream_failed', level: 'error' };
  }
}

/** The single decision point: every response body and status below 200 OK comes from here. */
export function classify(error: unknown): Classification {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.expose ? error.message : UNEXPECTED,
      code: error.code ?? codeForStatus(error.status),
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      level: error.status >= 500 ? 'error' : 'warn',
    };
  }
  // Authorization decisions the dashboard service makes while loading, which already carry a status.
  if (error instanceof DashboardAccessError) {
    return { status: error.status, message: error.status < 500 ? error.message : UNEXPECTED, code: error.status === 403 ? 'forbidden' : error.status === 404 ? 'not_found' : 'bad_request', level: error.status >= 500 ? 'error' : 'warn' };
  }
  if (error instanceof SleeperApiError) {
    return classifyUpstream(error.category, error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : undefined);
  }
  if (error instanceof ProviderFetchError) return classifyUpstream(error.category);

  switch (bodyParserType(error)) {
    case 'entity.too.large':
      return { status: 413, message: 'The request body is larger than this endpoint accepts.', code: 'body_too_large', level: 'warn' };
    case 'entity.parse.failed':
      return { status: 400, message: 'The request body is not valid JSON.', code: 'invalid_json', level: 'warn' };
    case 'entity.verify.failed': case 'encoding.unsupported': case 'charset.unsupported':
      return { status: 415, message: 'The request body must be UTF-8 encoded JSON.', code: 'unsupported_media_type', level: 'warn' };
    case 'request.aborted': case 'request.size.invalid': case 'parameters.too.many':
      return { status: 400, message: 'The request could not be read.', code: 'bad_request', level: 'warn' };
  }
  // Everything else is a defect in this application until proven otherwise, and is reported as one.
  return { status: 500, message: UNEXPECTED, code: 'internal', level: 'error' };
}

/** The id a caller quotes when they report a failure, and the join key to the line in the log. */
export const requestIdOf = (res: express.Response): string | undefined =>
  typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

/**
 * The terminal handler.
 *
 * It logs once, at the level the classification chose, and answers with a body whose shape is the same
 * for every failure in the API: `{ error, code, requestId }`. The log line carries the classification
 * *and* the original error, redacted; the response carries neither.
 */
export function errorHandler(log: Logger): express.ErrorRequestHandler {
  return (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const classification = classify(error);
    const fields = {
      status: classification.status, code: classification.code,
      method: req.method, route: routeOf(req), requestId: requestIdOf(res), error,
    };
    if (classification.level === 'error') log.error(fields, 'request failed');
    else log.warn(fields, 'request refused');

    // Headers already sent means the failure happened mid-body; there is no status left to set, and
    // the only correct action is to let Express destroy the connection rather than append JSON to a
    // half-written response.
    if (res.headersSent) return next(error);
    if (classification.retryAfterSeconds !== undefined) res.set('Retry-After', String(classification.retryAfterSeconds));
    res.status(classification.status).json({
      error: classification.message,
      code: classification.code,
      ...(requestIdOf(res) ? { requestId: requestIdOf(res) } : {}),
    });
  };
}

/** Unmatched routes, answered in the API's own shape rather than as the framework's HTML page. */
export function notFoundHandler(): express.RequestHandler {
  return (_req, _res, next) => next(new HttpError(404, 'No such endpoint.', { code: 'no_such_endpoint' }));
}

/** The matched route pattern, which is bounded and safe to index on, rather than the caller's path. */
export function routeOf(req: express.Request): string {
  const pattern = req.route?.path;
  if (typeof pattern === 'string') return `${req.baseUrl ?? ''}${pattern}` || '/';
  if (Array.isArray(pattern)) return `${req.baseUrl ?? ''}${String(pattern[0])}`;
  return 'unmatched';
}
