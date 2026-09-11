import type express from 'express';

/**
 * What may hold a copy of a response, and for how long.
 *
 * Almost everything this API returns is one account's view of one league: its rosters, its waiver
 * budget, the trades it is being advised to make. A response like that must never be stored by a
 * shared cache, because the only thing distinguishing two accounts' requests for
 * `/api/dashboard/1234` is a cookie — and a cache keyed on the URL will happily serve one manager's
 * dashboard to another.
 *
 * So the default is the strict one and every relaxation is deliberate:
 *
 * - **`private, no-store` by default**, applied to every response before routing. A policy chosen
 *   per route is a policy missing from every response that never reaches a route: the 401 from
 *   authentication, the 429 from a limiter, the 500 from the terminal handler.
 * - **`private, no-cache` where revalidation earns something.** The player directory is large and
 *   changes daily, so the browser is allowed to keep a copy and ask whether it is still current;
 *   Express answers the conditional request from its own ETag. `no-cache` is permission to store and
 *   an obligation to revalidate, which is not `no-store` and is not `max-age=0` either.
 * - **`public` only where the body is the same for everybody.** Which, in this API, is the sample
 *   league and nothing else.
 *
 * `Vary` matters as much as the directive. A response whose content depends on the session cookie
 * and whose CORS headers depend on the origin has to say so, or a cache that was told it may store
 * something will store the wrong variant of it.
 */

/** Every response that depends on who is asking. The default, applied before routing. */
export function noStore(): express.RequestHandler {
  return (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    // `Origin` because the CORS headers differ by it; `Cookie` because the body does.
    res.vary('Origin');
    res.vary('Cookie');
    next();
  };
}

/**
 * A user-specific response the browser may keep and must revalidate before reusing.
 *
 * For bodies that are large, change slowly and are read repeatedly — the player directory, a league
 * detail fan-out — where a 304 saves the transfer without ever serving a stale roster.
 */
export function privateRevalidated(res: express.Response): express.Response {
  res.set('Cache-Control', 'private, no-cache, must-revalidate');
  res.vary('Cookie');
  return res;
}

/**
 * A response with no account in it, which any cache may keep for a short while.
 *
 * The sample league is fiction: the same bytes for every caller, generated rather than synchronized,
 * and unreachable in production, where `ENABLE_DEMO_AUTH` is refused outright. That is what makes
 * `public` correct here and nowhere else in this API — there is no account whose data a shared cache
 * could hand to the wrong person, because there is no account in it.
 */
export function publicCached(res: express.Response, seconds: number): express.Response {
  res.set('Cache-Control', `public, max-age=${seconds}, must-revalidate`);
  return res;
}

/**
 * A liveness answer, which is worthless the moment it is stored.
 *
 * A cached `/health` is a load balancer being told an instance is up because it was up a minute ago,
 * which is the one minute in which the answer mattered.
 */
export function neverStored(res: express.Response): express.Response {
  res.set('Cache-Control', 'no-store');
  return res;
}
