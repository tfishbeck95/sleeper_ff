import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type express from 'express';
import type { ApplicationSession, ApplicationUser, JsonStore } from './store.js';

const scrypt = promisify(scryptCallback);
const HOUR = 3_600_000, MINUTE = 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * A failed login must cost the same as a successful one, otherwise the response time discloses which
 * logins exist. Unknown logins are verified against this throwaway hash instead of returning early.
 */
const absentUserHash = '$absent$';
let absentUserHashValue: Promise<string> | undefined;
async function costOfVerifyingAnAbsentUser() { absentUserHashValue ??= passwordHash(randomBytes(32).toString('hex')); await passwordMatches(absentUserHash, await absentUserHashValue); }

export async function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`; }
export async function passwordMatches(password: string, encoded: string) { const [scheme, salt, expected] = encoded.split(':'); if (scheme !== 'scrypt' || !salt || !expected) return false; const actual = await scrypt(password, salt, 64) as Buffer; const wanted = Buffer.from(expected, 'hex'); return wanted.length === actual.length && timingSafeEqual(wanted, actual); }
export async function verifyLogin(user: ApplicationUser | undefined, password: string) { if (!user) { await costOfVerifyingAnAbsentUser(); return false; } return passwordMatches(password, user.passwordHash); }

/** Demo data and demo login are a development affordance: production never serves either, whatever the flag says. */
export function demoEnabled(env: NodeJS.ProcessEnv = process.env) { return env.NODE_ENV !== 'production' && env.ENABLE_DEMO_AUTH === 'true'; }
/** Dropping `__Host-`/`Secure` is the only way to sign in over plain http, so it is an explicit, non-production opt-in. */
export function insecureCookiesEnabled(env: NodeJS.ProcessEnv = process.env) { return env.NODE_ENV !== 'production' && env.INSECURE_DEV_COOKIES === 'true'; }
export const COOKIE_NAME = '__Host-huddle_session';
const DEV_COOKIE_NAME = 'huddle_session';
export function cookieName(env: NodeJS.ProcessEnv = process.env) { return insecureCookiesEnabled(env) ? DEV_COOKIE_NAME : COOKIE_NAME; }

export interface SessionPolicy { absoluteMs: number; idleMs: number; rotateMs: number; graceMs: number; touchMs: number; }
function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, unitMs: number) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback * unitMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Refusing to start: ${name} must be a positive number.`);
  return value * unitMs;
}
export function sessionPolicy(env: NodeJS.ProcessEnv = process.env): SessionPolicy {
  const absoluteMs = positiveNumber(env, 'SESSION_TTL_HOURS', 24, HOUR);
  // An idle window longer than the absolute lifetime would silently never apply; clamping keeps both meaningful.
  const idleMs = Math.min(positiveNumber(env, 'SESSION_IDLE_MINUTES', 120, MINUTE), absoluteMs);
  // Renewing the idle window costs a store write, so it is throttled — but never so coarsely that a short
  // idle window could lapse between renewals.
  return { absoluteMs, idleMs, rotateMs: Math.min(positiveNumber(env, 'SESSION_ROTATE_MINUTES', 30, MINUTE), absoluteMs), graceMs: positiveNumber(env, 'SESSION_ROTATION_GRACE_SECONDS', 60, 1000), touchMs: Math.min(MINUTE, idleMs / 10) };
}

export function validateAuthenticationConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production && env.ENABLE_DEMO_AUTH === 'true') throw new Error('Refusing to start: demo authentication cannot be enabled in production.');
  if (production && env.INSECURE_DEV_COOKIES === 'true') throw new Error('Refusing to start: INSECURE_DEV_COOKIES cannot be enabled in production.');
  if (production && !env.APP_LOGIN_PASSWORD_HASH && !env.IDENTITY_PROVIDER) throw new Error('Production requires APP_LOGIN_PASSWORD_HASH or an application identity provider.');
  if (production && env.APP_LOGIN_PASSWORD_HASH && !/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(env.APP_LOGIN_PASSWORD_HASH)) throw new Error('Refusing to start: APP_LOGIN_PASSWORD_HASH is not a scrypt hash. Generate one with npm run password-hash.');
  if (production && !env.WEB_ORIGIN) throw new Error('Refusing to start: WEB_ORIGIN must name the browser origin allowed to send credentialed requests.');
  if (env.WEB_ORIGIN) {
    let origin: URL;
    try { origin = new URL(env.WEB_ORIGIN); } catch { throw new Error('Refusing to start: WEB_ORIGIN must be an absolute origin such as https://huddle.example.com.'); }
    if (origin.protocol !== 'https:' && !(!production && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Refusing to start: WEB_ORIGIN must use https outside local development.');
  }
  sessionPolicy(env);
}

export function sessionCookie(value: string, maxAgeMs: number, env: NodeJS.ProcessEnv = process.env) { return `${cookieName(env)}=${value}; Path=/; HttpOnly; ${insecureCookiesEnabled(env) ? 'SameSite=Lax' : 'Secure; SameSite=Strict'}; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`; }
export function clearSessionCookie(env: NodeJS.ProcessEnv = process.env) { return sessionCookie('', 0, env); }
function cookie(req: express.Request) { const name = cookieName(); return req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1); }

export interface Authentication { user: ApplicationUser; session: ApplicationSession; rawSessionId: string; }

/** Issues a brand new session family. Callers use it for login only; live sessions rotate instead. */
export async function issueSession(store: JsonStore, user: ApplicationUser, policy = sessionPolicy()) {
  const rawSessionId = token(), csrfToken = token(), now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteMs).toISOString();
  const session: ApplicationSession = {
    idHash: digest(rawSessionId), userId: user.id, familyId: randomUUID(), csrfHashes: [digest(csrfToken)],
    createdAt: now.toISOString(), lastRotatedAt: now.toISOString(), lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.min(policy.idleMs, policy.absoluteMs)).toISOString(), absoluteExpiresAt,
  };
  await store.saveSession(session);
  // Login is the natural moment to pay for housekeeping: it is rare and already writing.
  await store.pruneSessions();
  return { rawSessionId, csrfToken, maxAge: policy.absoluteMs, session };
}

/** Rotates the session id inside its family, preserving the CSRF tokens the client already holds. */
export async function rotateSession(store: JsonStore, current: ApplicationSession, policy = sessionPolicy(), now = new Date()) {
  const rawSessionId = token();
  const absolute = Date.parse(current.absoluteExpiresAt);
  const next: ApplicationSession = {
    ...current, idHash: digest(rawSessionId), lastRotatedAt: now.toISOString(), lastSeenAt: now.toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + policy.idleMs, absolute)).toISOString(), supersededAt: undefined,
  };
  await store.rotateSession(current.idHash, next, now.toISOString());
  return { rawSessionId, session: next, maxAge: Math.max(0, absolute - now.getTime()) };
}

/** Adds a CSRF token to the session so a reloaded page (or a second tab) can mutate without signing in again. */
export async function issueCsrfToken(store: JsonStore, session: ApplicationSession) {
  const csrfToken = token();
  await store.addSessionCsrfHash(session.idHash, digest(csrfToken));
  return csrfToken;
}

export function authentication(store: JsonStore, policy = sessionPolicy()) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const rawSessionId = cookie(req);
    if (!rawSessionId) return res.status(401).json({ error: 'Authentication required.' });
    const reject = (error: string) => res.status(401).append('Set-Cookie', clearSessionCookie()).json({ error });
    let session = await store.session(digest(rawSessionId));
    const now = Date.now();
    if (!session) return reject('Session expired or revoked.');
    if (session.revokedAt) {
      // A revoked id in the hands of a client means the family may be compromised; retire all of it.
      await store.revokeSessionFamily(session.familyId, 'reuse-detected');
      return reject('Session expired or revoked.');
    }
    if (Date.parse(session.expiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) {
      await store.revokeSession(session.idHash, 'expired');
      return reject('Session expired. Sign in again.');
    }
    if (session.supersededAt && now - Date.parse(session.supersededAt) > policy.graceMs) {
      await store.revokeSessionFamily(session.familyId, 'reuse-detected');
      return reject('Session expired or revoked.');
    }
    const user = await store.applicationUser(session.userId);
    if (!user) { await store.revokeSessionFamily(session.familyId, 'user-removed'); return reject('Authentication required.'); }

    let current = { rawSessionId, session };
    if (!session.supersededAt && now - Date.parse(session.lastRotatedAt) >= policy.rotateMs) {
      const rotated = await rotateSession(store, session, policy, new Date(now));
      current = { rawSessionId: rotated.rawSessionId, session: rotated.session };
      res.append('Set-Cookie', sessionCookie(rotated.rawSessionId, rotated.maxAge));
    } else if (!session.supersededAt && now - Date.parse(session.lastSeenAt) >= policy.touchMs) {
      // Sliding idle window. Throttled so an active client does not write to the store on every request.
      const expiresAt = new Date(Math.min(now + policy.idleMs, Date.parse(session.absoluteExpiresAt))).toISOString();
      await store.touchSession(session.idHash, expiresAt, new Date(now).toISOString());
      session = { ...session, expiresAt, lastSeenAt: new Date(now).toISOString() };
      current = { rawSessionId, session };
    }
    res.locals.auth = { user, session: current.session, rawSessionId: current.rawSessionId } satisfies Authentication;
    next();
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function csrf(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const auth = res.locals.auth as Authentication;
  const supplied = req.header('x-csrf-token');
  if (!supplied || !auth.session.csrfHashes.some(hash => equal(hash, digest(supplied)))) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}

export const authDigest = digest;
