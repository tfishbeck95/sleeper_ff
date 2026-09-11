import type express from 'express';
import type { Authentication } from './auth.js';
import { tooManyRequests } from './http/errors.js';
import { rateLimitEvents } from './observability/instruments.js';

/**
 * Fixed-window counters held in this process.
 *
 * Every budget here is charged along two dimensions at once, because each one alone has a hole the
 * other closes:
 *
 * - **Per address** bounds what an unauthenticated caller can do, and is the only dimension
 *   available before a request is authenticated. On its own it punishes shared egress: a household,
 *   an office or a mobile carrier's NAT is one address, so the budget has to be loose enough for all
 *   of them — and therefore loose enough for one signed-in client to spend the whole thing.
 * - **Per session** bounds what one signed-in client can do regardless of how many addresses it
 *   speaks from, which is what makes a tight budget safe: it is per session, so it never affects the
 *   other people behind the same address.
 *
 * A request is refused when *either* is exhausted, and both are charged either way. The session key
 * is the session *family* rather than the session id, because the id rotates every thirty minutes
 * and a budget that resets on rotation is a budget an attacker resets by waiting.
 *
 * Addresses are collapsed to a /64 for IPv6. A single residential IPv6 allocation is at least that
 * large, so counting individual v6 addresses is counting nothing at all.
 *
 * Buckets are swept as they are read and the map is capped, so a caller rotating source addresses
 * cannot turn the limiter into the memory exhaustion it exists to prevent. A multi-instance
 * deployment needs a shared store instead; see docs/identity-and-sessions.md.
 */
interface Window { start: number; count: number; }
const MAX_TRACKED_KEYS = 20_000;
const windows = new Map<string, Window>();
let sweptAt = 0;

function sweep(now: number, windowMs: number) {
  if (now - sweptAt < 60_000 && windows.size < MAX_TRACKED_KEYS) return;
  sweptAt = now;
  for (const [key, value] of windows) if (now - value.start >= Math.max(windowMs, 60_000)) windows.delete(key);
  // Insertion order is oldest first, so dropping from the front discards the least recently started windows.
  if (windows.size >= MAX_TRACKED_KEYS) for (const key of [...windows.keys()].slice(0, windows.size - MAX_TRACKED_KEYS + 1)) windows.delete(key);
}

/**
 * The address a budget is charged to.
 *
 * IPv6 is truncated to its routing prefix: `2001:db8:1:2:3:4:5:6` and every other address in that
 * /64 are one caller as far as a limit is concerned, because they are one caller as far as an
 * allocation is concerned. IPv4 is used whole, including the mapped `::ffff:` form Node reports on a
 * dual-stack socket.
 */
export function clientAddress(req: express.Request): string {
  const raw = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (!address.includes(':')) return address;
  const groups = address.split(':');
  return groups.length > 4 ? `${groups.slice(0, 4).join(':')}::/64` : address;
}

/**
 * The session a budget is charged to, or the address when there is no session yet.
 *
 * The family id rather than the session id: rotation issues a new id for the same session, and a
 * counter keyed on the id would start again with it.
 */
export function sessionKey(req: express.Request, res: express.Response): string {
  const auth = res.locals.auth as Authentication | undefined;
  return auth ? `session:${auth.session.familyId}` : `address:${clientAddress(req)}`;
}

export interface RateLimitScope {
  /** How many requests this identity may make in the window. */
  max: number;
  /** What the budget is charged to. */
  key: (req: express.Request, res: express.Response) => string;
  /** Distinguishes this scope's counters from the others' in the same bucket. */
  name: string;
}

export interface RateLimitOptions {
  /** Name of the shared budget. Distinct buckets never share a counter. */
  bucket: string;
  windowMs: number;
  /** Requests one client address may make. Omitted only where the address is meaningless. */
  perAddress?: number;
  /** Requests one signed-in session may make. Falls back to the address when unauthenticated. */
  perSession?: number;
  /**
   * A third budget charged to something the request names rather than to who sent it — the submitted
   * login, so that a botnet cannot grind one account by spreading the attempts across addresses.
   */
  perSubject?: { max: number; key: (req: express.Request) => string };
  message?: string;
}

interface Charge { scope: string; limit: number; remaining: number; resetSeconds: number; exceeded: boolean }

function charge(now: number, id: string, max: number, windowMs: number, scope: string): Charge {
  let value = windows.get(id);
  if (!value || now - value.start >= windowMs) { value = { start: now, count: 0 }; windows.delete(id); }
  value.count++;
  windows.set(id, value);
  return {
    scope, limit: max, remaining: Math.max(0, max - value.count),
    resetSeconds: Math.max(1, Math.ceil((value.start + windowMs - now) / 1000)),
    exceeded: value.count > max,
  };
}

export function rateLimit(options: RateLimitOptions): express.RequestHandler {
  const { bucket, windowMs, message = 'Too many requests. Try again later.' } = options;
  const scopes: RateLimitScope[] = [];
  if (options.perAddress !== undefined) scopes.push({ name: 'address', max: options.perAddress, key: clientAddress });
  if (options.perSession !== undefined) scopes.push({ name: 'session', max: options.perSession, key: sessionKey });
  if (options.perSubject) scopes.push({ name: 'subject', max: options.perSubject.max, key: req => options.perSubject!.key(req) });
  if (!scopes.length) throw new Error(`Rate limit '${bucket}' defines no budget.`);

  return (req, res, next) => {
    const now = Date.now();
    sweep(now, windowMs);
    // Every scope is charged, including on a request another scope has already refused: a caller
    // must not be able to keep one budget intact by deliberately exhausting a different one.
    const charges = scopes.map(scope => charge(now, `${bucket}:${scope.name}:${scope.key(req, res)}`, scope.max, windowMs, scope.name));
    // The headers describe the budget closest to running out, which is the one the client can act on.
    const tightest = charges.reduce((worst, entry) => (entry.remaining < worst.remaining ? entry : worst));
    res.set('RateLimit-Limit', String(tightest.limit));
    res.set('RateLimit-Remaining', String(tightest.remaining));
    res.set('RateLimit-Reset', String(tightest.resetSeconds));
    const exceeded = charges.find(entry => entry.exceeded);
    if (exceeded) {
      // Which dimension ran out is the operational question: an address budget exhausting is a
      // flood, a session budget exhausting is one client in a loop, and they need different actions.
      rateLimitEvents.inc({ bucket, scope: exceeded.scope });
      return next(tooManyRequests(message, exceeded.resetSeconds));
    }
    next();
  };
}

/** Test-only: drops every counter so suites do not inherit each other's budgets. */
export function resetRateLimits() { windows.clear(); sweptAt = 0; }
