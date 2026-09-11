import type express from 'express';

/**
 * The headers every response carries, whatever it is and however it ended.
 *
 * This is an API that answers JSON and nothing else. It renders no markup, embeds no third-party
 * script and is never framed, so its policy can be the strictest one a browser understands rather
 * than a negotiated one: `default-src 'none'` denies every fetch a response could initiate if a
 * browser were ever persuaded to treat one as a document.
 *
 * That "if" is the reason these are here at all. A JSON API looks like it has no browser attack
 * surface until something makes a browser parse one of its responses as HTML — a mistyped
 * `Content-Type`, an error page from a proxy in front of it, a download opened in a tab — at which
 * point the response is a document on the API's own origin, holding the session cookie. `nosniff`,
 * the policy and the sandbox make that document inert.
 *
 * They are installed before anything else in the stack so that a 404 from the router, a 429 from a
 * rate limiter, a 500 from the terminal handler and a body the parser refused all carry them. A
 * header set per route is a header missing from every path that does not reach a route.
 */

export interface SecurityHeaderOptions {
  /**
   * Whether to assert HSTS. Sending it from a development server on plain http teaches the browser
   * to refuse the development server, so it is gated on the deployment actually terminating TLS.
   */
  https: boolean;
  /** How long a browser should remember the HSTS assertion. Two years is the preload-list floor. */
  hstsMaxAgeSeconds?: number;
}

/**
 * `sandbox` with no allowances is the part worth reading twice: it removes scripting, forms, popups
 * and same-origin privileges from any document a browser makes of a response here. Combined with
 * `default-src 'none'`, a JSON body that a browser was tricked into rendering can do nothing at all.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox',
].join('; ');

/**
 * Features this API has no use for, denied rather than left to a browser's default.
 *
 * An API cannot use a camera, but a document made out of one of its responses inherits the origin's
 * permissions, and an origin that has never asked for a permission is the easiest one to keep.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'encrypted-media=()',
  'fullscreen=()', 'geolocation=()', 'gyroscope=()', 'magnetometer=()', 'microphone=()',
  'midi=()', 'payment=()', 'picture-in-picture=()', 'screen-wake-lock=()', 'usb=()', 'xr-spatial-tracking=()',
].join(', ');

export function securityHeaders({ https, hstsMaxAgeSeconds = 63_072_000 }: SecurityHeaderOptions): express.RequestHandler {
  // Assembled once: these are the same strings on every response, and building them per request is
  // work done a few thousand times a minute for no reason.
  const headers: Record<string, string> = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    // A browser that guesses a response's type can guess `text/html` for a JSON body that happens to
    // start with a tag. This is the header that stops the guess.
    'X-Content-Type-Options': 'nosniff',
    // `frame-ancestors` above is the modern statement; this is the same statement to browsers that
    // only know the older header.
    'X-Frame-Options': 'DENY',
    // A URL here can carry a league id. Nothing downstream needs to know where a request came from.
    'Referrer-Policy': 'no-referrer',
    // A response must not become a subresource of some other site's page. `same-site` rather than
    // `same-origin` because the dashboard is legitimately served from a sibling origin.
    'Cross-Origin-Resource-Policy': 'same-site',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Keeps this origin out of a shared agent cluster, so a document on it cannot be reached by
    // `document.domain` relaxation from a sibling.
    'Origin-Agent-Cluster': '?1',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': PERMISSIONS_POLICY,
  };
  if (https) headers['Strict-Transport-Security'] = `max-age=${hstsMaxAgeSeconds}; includeSubDomains`;

  return (_req, res, next) => { res.set(headers); next(); };
}

/**
 * Whether this deployment is reached over https.
 *
 * Production is, by the topology in docs/deployment.md: a load balancer terminates TLS and forwards
 * to the API. `INSECURE_DEV_COOKIES` is the same opt-out the session cookie uses for a developer on
 * a machine without TLS, and asserting HSTS at them would break the next thing they load on
 * localhost, so it is honoured here too.
 */
export function servesHttps(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && env.INSECURE_DEV_COOKIES !== 'true';
}
