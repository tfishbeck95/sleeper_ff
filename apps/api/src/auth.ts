import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import type { ApplicationSession, ApplicationUser, JsonStore } from './store.js';

const scrypt = promisify(scryptCallback);
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const MIN_SESSION_TTL_HOURS = 1;
const MAX_SESSION_TTL_HOURS = 24 * 30;
export const COOKIE_NAME = '__Host-huddle_session';

function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function randomToken() { return randomBytes(32).toString('base64url'); }
function safeDigestMatch(value: string, expectedDigest: string) {
  const actual = Buffer.from(digest(value), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function sessionTtlMs(env = process.env) {
  const hours = Number(env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_MS / 3_600_000);
  if (!Number.isFinite(hours) || hours < MIN_SESSION_TTL_HOURS || hours > MAX_SESSION_TTL_HOURS) throw new Error(`SESSION_TTL_HOURS must be between ${MIN_SESSION_TTL_HOURS} and ${MAX_SESSION_TTL_HOURS}.`);
  return hours * 3_600_000;
}

export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`;
}

export async function passwordMatches(password: string, encoded: string) {
  const [algorithm, salt, expectedHex, extra] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex || extra || !/^[a-f\d]{128}$/i.test(expectedHex)) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return timingSafeEqual(actual, expected);
}

export function validateAuthenticationConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' && env.ENABLE_DEMO_AUTH === 'true') throw new Error('Refusing to start: demo authentication cannot be enabled in production.');
  if (env.NODE_ENV === 'production' && !env.APP_LOGIN_PASSWORD_HASH) throw new Error('Production requires APP_LOGIN_PASSWORD_HASH. An identity provider must be implemented before multi-user launch.');
  if (env.APP_LOGIN_PASSWORD_HASH && !/^scrypt:[a-f\d]{32}:[a-f\d]{128}$/i.test(env.APP_LOGIN_PASSWORD_HASH)) throw new Error('APP_LOGIN_PASSWORD_HASH is not a valid generated scrypt hash.');
  sessionTtlMs(env);
}

export function sessionCookie(value: string, maxAgeMs: number) { return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`; }
export function clearSessionCookie() { return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
function sessionId(req: Request) { return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1); }

export interface Authentication { user: ApplicationUser; session: ApplicationSession; rawSessionId: string; }
export function authentication(store: JsonStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawSessionId = sessionId(req);
      if (!rawSessionId) return res.status(401).json({ error: 'Authentication required.' });
      const session = await store.session(digest(rawSessionId));
      if (!session || !session.csrfToken || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return res.status(401).set('Set-Cookie', clearSessionCookie()).json({ error: 'Session expired or revoked.' });
      const user = await store.applicationUser(session.userId);
      if (!user) return res.status(401).set('Set-Cookie', clearSessionCookie()).json({ error: 'Authentication required.' });
      res.locals.auth = { user, session, rawSessionId } satisfies Authentication;
      next();
    } catch (error) { next(error); }
  };
}

export function csrf(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const supplied = req.header('x-csrf-token');
  const auth = res.locals.auth as Authentication;
  if (!supplied || !safeDigestMatch(supplied, auth.session.csrfHash)) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}

export async function issueSession(store: JsonStore, user: ApplicationUser, previous?: Authentication) {
  const rawSessionId = randomToken();
  const csrfToken = randomToken();
  const now = new Date();
  const maxAge = sessionTtlMs();
  if (previous) await store.revokeSession(previous.session.idHash);
  const session: ApplicationSession = { idHash: digest(rawSessionId), csrfHash: digest(csrfToken), csrfToken, userId: user.id, createdAt: now.toISOString(), lastRotatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + maxAge).toISOString() };
  await store.saveSession(session);
  return { rawSessionId, csrfToken, maxAge, session };
}
