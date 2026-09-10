import type express from 'express';
import type { Authentication } from './auth.js';

/**
 * Fixed-window counters held in this process. Buckets are swept as they are read and the map is capped,
 * so an attacker rotating source addresses cannot turn the limiter itself into the memory exhaustion it
 * is meant to prevent. A multi-instance deployment needs a shared store instead; see
 * docs/identity-and-sessions.md.
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

export interface RateLimitOptions {
  /** Name of the shared budget. Distinct buckets never share a counter. */
  bucket: string;
  max: number;
  windowMs: number;
  /** Identity the budget is charged to. Defaults to the client address. */
  key?: (req: express.Request, res: express.Response) => string;
  message?: string;
}

/** Charges an authenticated user rather than their address, so one signed-in client cannot spend a whole network's budget. */
export const bySession = (req: express.Request, res: express.Response) => (res.locals.auth as Authentication | undefined)?.user.id ?? req.ip ?? 'unknown';

export function rateLimit({ bucket, max, windowMs, key, message = 'Too many requests. Try again later.' }: RateLimitOptions) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    sweep(now, windowMs);
    const id = `${bucket}:${key ? key(req, res) : req.ip ?? 'unknown'}`;
    let value = windows.get(id);
    if (!value || now - value.start >= windowMs) { value = { start: now, count: 0 }; windows.delete(id); }
    value.count++;
    windows.set(id, value);
    const resetSeconds = Math.max(1, Math.ceil((value.start + windowMs - now) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - value.count)));
    res.set('RateLimit-Reset', String(resetSeconds));
    if (value.count > max) return res.status(429).set('Retry-After', String(resetSeconds)).json({ error: message });
    next();
  };
}

/** Test-only: drops every counter so suites do not inherit each other's budgets. */
export function resetRateLimits() { windows.clear(); sweptAt = 0; }

/** `req.ip` is only trustworthy once Express knows how many proxies sit in front of it. */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}
