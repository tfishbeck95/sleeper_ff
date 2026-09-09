import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type express from 'express';
import type { ApplicationSession, ApplicationUser, JsonStore } from './store.js';

const scrypt = promisify(scryptCallback);
export const COOKIE_NAME = '__Host-huddle_session';
const DAY = 86_400_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export async function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`; }
export async function passwordMatches(password: string, encoded: string) { const [, salt, expected] = encoded.split(':'); if (!salt || !expected) return false; const actual = await scrypt(password, salt, 64) as Buffer; const wanted = Buffer.from(expected, 'hex'); return wanted.length === actual.length && timingSafeEqual(wanted, actual); }
export function validateAuthenticationConfig(env = process.env) {
  if (env.NODE_ENV === 'production' && env.ENABLE_DEMO_AUTH === 'true') throw new Error('Refusing to start: demo authentication cannot be enabled in production.');
  if (env.NODE_ENV === 'production' && !env.APP_LOGIN_PASSWORD_HASH && !env.IDENTITY_PROVIDER) throw new Error('Production requires APP_LOGIN_PASSWORD_HASH or an application identity provider.');
}
export function sessionCookie(value: string, maxAgeMs: number) { return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`; }
export function clearSessionCookie() { return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
function cookie(req: express.Request) { return req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1); }
export interface Authentication { user: ApplicationUser; session: ApplicationSession; rawSessionId: string; }
export function authentication(store: JsonStore) { return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rawSessionId = cookie(req); if (!rawSessionId) return res.status(401).json({ error: 'Authentication required.' });
  const session = await store.session(digest(rawSessionId)); const now = Date.now();
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now) return res.status(401).set('Set-Cookie', clearSessionCookie()).json({ error: 'Session expired or revoked.' });
  const user = await store.applicationUser(session.userId); if (!user) return res.status(401).json({ error: 'Authentication required.' });
  res.locals.auth = { user, session, rawSessionId } satisfies Authentication; next();
}; }
export function csrf(req: express.Request, res: express.Response, next: express.NextFunction) { if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next(); const auth = res.locals.auth as Authentication; const supplied = req.header('x-csrf-token'); if (!supplied || digest(supplied) !== auth.session.csrfHash) return res.status(403).json({ error: 'Invalid CSRF token.' }); next(); }
export async function issueSession(store: JsonStore, user: ApplicationUser, previous?: Authentication) { const rawSessionId = token(), csrfToken = token(), now = new Date(); const maxAge = Number(process.env.SESSION_TTL_HOURS ?? 24) * 3_600_000; if (previous) await store.revokeSession(previous.session.idHash); const session: ApplicationSession = { idHash: digest(rawSessionId), csrfHash: digest(csrfToken), userId: user.id, createdAt: now.toISOString(), lastRotatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + maxAge).toISOString() }; await store.saveSession(session); return { rawSessionId, csrfToken, maxAge, session }; }
export const authDigest = digest;
