import cors from 'cors';
import type express from 'express';

/**
 * Which browser origins may send a credentialed request, stated exactly and never inferred.
 *
 * The grant here and the session cookie are the same boundary seen from two sides. A cookie only
 * travels to the origin that set it; this list decides which *other* origins a browser will let read
 * the response. Widen either one and a page on some other host can act as a signed-in user.
 *
 * So there is no permissive fallback, and specifically none of the three that usually appear:
 *
 * - **No wildcard.** `Access-Control-Allow-Origin: *` is refused by browsers alongside
 *   `credentials: true`, which is often discovered by echoing the request's own origin instead —
 *   arriving at "every origin is allowed" through a route that looks like a fix.
 * - **No reflection.** The allowed set is an exact-match array. An origin that is not in it receives
 *   no `Access-Control-Allow-Origin` at all, which is what makes the browser refuse the response.
 * - **No development default in production.** An unconfigured production deployment does not fall
 *   back to a localhost origin; it does not start. That refusal lives in `validateEnvironment`, and
 *   the guard below is the second half of it: the application cannot be *constructed* permissively
 *   either, however it was reached.
 *
 * A suffix or pattern match is deliberately not offered. `*.example.com` allows every subdomain,
 * including whichever one is serving somebody's uploaded content, and one of those is enough.
 */

export class CorsConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'CorsConfigurationError'; }
}

/** Headers a browser is allowed to send. Anything else fails preflight rather than being ignored. */
const ALLOWED_REQUEST_HEADERS = ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'If-None-Match'];
/**
 * Headers a browser is allowed to read back. Without this the dashboard can see the status and the
 * body and nothing else, which would leave it unable to show a rate-limit countdown or to quote the
 * request id from a failure.
 */
const EXPOSED_RESPONSE_HEADERS = ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'ETag'];

export interface CorsOptions {
  /** Exact origins, already parsed and validated by `config/origins.ts`. */
  origins: readonly string[];
  production: boolean;
}

export function corsPolicy({ origins, production }: CorsOptions): express.RequestHandler {
  if (production && origins.length === 0) {
    throw new CorsConfigurationError('Refusing to start: no WEB_ORIGIN is configured, and production has no default origin to fall back to. Name the exact origin the dashboard is served from.');
  }
  const allowed = [...origins];
  return cors({
    // An array, not a function and not `true`: the middleware compares the request's origin against
    // it and answers with that exact string or with no header at all. There is no path through this
    // configuration that produces a wildcard or an echo.
    origin: allowed,
    credentials: true,
    // The API answers reads and writes and nothing else. PUT, PATCH and DELETE are not routes here,
    // and a preflight for one should fail at the preflight rather than at the router.
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    // Ten minutes of preflight caching. Long enough that a dashboard session is not re-flighting
    // every request, short enough that removing an origin takes effect while someone is still angry
    // about having had to remove it.
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}
