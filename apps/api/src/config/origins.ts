/**
 * The browser origins allowed to send credentialed requests.
 *
 * Session cookies only travel to an origin named here, so this list is the boundary between "the
 * dashboard can sign in" and "any page on the internet can spend a signed-in user's session". It is
 * parsed in one place because two readers that disagree — the CORS layer and the startup check — is
 * exactly how an origin ends up allowed by one and not the other.
 *
 * A list rather than a single value, because a real deployment has more than one legitimate front end
 * at some point: a staging domain and its preview host, or a cutover from one hostname to the next. It
 * is still a list of exact origins; there is no wildcard and no suffix match, because `credentials:
 * true` with a pattern is how the boundary stops meaning anything.
 */

export const DEVELOPMENT_ORIGIN = 'http://localhost:5173';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export class OriginError extends Error {
  constructor(message: string) { super(message); this.name = 'OriginError'; }
}

/**
 * Parses `WEB_ORIGIN` into exact origins, refusing anything that would not mean what it looks like.
 *
 * `https://huddle.example.com/app` is the case worth refusing out loud: `URL.origin` silently discards
 * the path, so it would be accepted and then allow every page on that host. Someone who wrote it meant
 * to narrow the grant, and being told is better than being quietly widened.
 */
export function parseWebOrigins(value: string | undefined, { production }: { production: boolean }): string[] {
  const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  const origins: string[] = [];
  for (const entry of entries) {
    let url: URL;
    try { url = new URL(entry); } catch { throw new OriginError(`Refusing to start: WEB_ORIGIN must be an absolute origin such as https://huddle.example.com, not '${entry}'.`); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OriginError(`Refusing to start: WEB_ORIGIN must name an http or https origin, not '${entry}'.`);
    if (url.username || url.password) throw new OriginError(`Refusing to start: WEB_ORIGIN must not carry credentials: '${entry}'.`);
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new OriginError(`Refusing to start: WEB_ORIGIN is an origin, not a URL — a path, query or fragment is not part of what a browser sends and is silently ignored. Use '${url.origin}' if that is what you meant, not '${entry}'.`);
    }
    if (url.protocol !== 'https:' && !(!production && LOOPBACK.includes(url.hostname))) throw new OriginError(`Refusing to start: WEB_ORIGIN must use https outside local development: '${entry}'.`);
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * The configured origins, or the development server's own when nothing is configured.
 *
 * Production has no default: `validateAuthenticationConfig` refuses to start without `WEB_ORIGIN`
 * rather than falling back to a localhost origin nothing in production can reach.
 */
export function webOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const production = env.NODE_ENV === 'production';
  const configured = parseWebOrigins(env.WEB_ORIGIN, { production });
  return configured.length ? configured : [DEVELOPMENT_ORIGIN];
}
