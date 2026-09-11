import express from 'express';
import { randomUUID } from 'node:crypto';
import { scoringUnavailable } from '@sleeper/domain';
import type { SleeperClient } from '@sleeper/sleeper-client';
import { CommandCenterService } from './command-center.js';
import { demoSnapshot } from './demo.js';
import type { HuddleRepository } from './storage/repositories.js';
import { LeagueSyncService } from './sync.js';
import { PlayerDirectoryService, leaguePlayerIds } from './players.js';
import { LeagueSyncWorker, type QueuedSyncJob } from './scheduler/index.js';
import { FileWaiverSignalProvider, type WaiverSignalProvider } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './waiver-demo.js';
import { parseTradeBounds, recommendTrades } from './trades.js';
import { demoTradeInput } from './trade-demo.js';
import { analyzeLineup } from './lineup.js';
import { demoLineupInput } from './lineup-demo.js';
import {
  authentication, clearSessionCookie, csrf, demoEnabled, issueCsrfToken, issueSession, rotateSession,
  sessionCookie, sessionPolicy, verifyLogin, type Authentication,
} from './auth.js';
import { rateLimit } from './rate-limit.js';
import { webOrigins } from './config/origins.js';
import { sleeperClient } from './config/upstream.js';
import { trustProxySetting } from './config/proxy.js';
import { isDraining } from './lifecycle.js';
import { logger as processLogger, type Logger } from './log.js';
import { BODY_LIMITS, guardBody, jsonBody } from './http/body.js';
import { neverStored, noStore, privateRevalidated, publicCached } from './http/cache.js';
import { corsPolicy } from './http/cors.js';
import { badRequest, errorHandler, forbidden, HttpError, notFound, notFoundHandler } from './http/errors.js';
import { accessLog, requestId } from './http/request-log.js';
import { securityHeaders, servesHttps } from './http/security.js';
import { fields, optional, param, playerSelection, query, suppliedBounds, tradeBoundFields, withDefault } from './http/validation.js';

function publicUser(user: import('./store.js').ApplicationUser){return {id:user.id,login:user.login,sleeperUserId:user.sleeperUserId,sleeperUsername:user.sleeperUsername,sleeperLeagueIds:user.sleeperLeagueIds};}
/**
 * What a client learns about a league's synchronization without waiting for one.
 *
 * It is the connection record plus this worker's view of the queue, so a refresh button can say the
 * useful things — this is queued, this last succeeded twenty minutes ago, this is waiting until 14:32
 * because Sleeper rate limited us — instead of only succeeding or failing.
 */
async function syncState(store: HuddleRepository, worker: LeagueSyncWorker, leagueId: string, job?: QueuedSyncJob) {
  const connection = await store.leagueConnection(leagueId);
  const state = worker.state(leagueId);
  return {
    leagueId, queued: state.queued || Boolean(job), running: state.running, queuePosition: state.position || null, queuedAt: job?.queuedAt ?? null,
    status: connection?.status ?? 'active', season: connection?.season ?? null, week: connection?.week ?? null,
    lastSyncedAt: connection?.lastSyncedAt ?? null, lastStatus: connection?.lastStatus ?? null,
    lastCategory: connection?.lastCategory ?? null, lastDurationMs: connection?.lastDurationMs ?? null,
    lastRefreshed: connection?.lastRefreshed ?? [], resourceFreshness: connection?.resourceFreshness ?? {},
    nextAttemptAt: connection?.nextAttemptAt ?? null, consecutiveFailures: connection?.consecutiveFailures ?? 0,
  };
}

/**
 * The budgets.
 *
 * Every one of them is charged along two dimensions: the client address, which is all there is
 * before a request is authenticated and which a household or an office shares, and the session,
 * which is one signed-in client however many addresses it speaks from. The address allowance is the
 * looser of the two precisely because it is shared — it exists to bound an anonymous flood, not to
 * ration a family — and the session allowance is what actually rations a client.
 *
 * The per-endpoint numbers come from what each one costs us rather than from what a client wants: a
 * league detail fans out to seven Sleeper calls and is budgeted an order of magnitude below a
 * dashboard read that touches only the store.
 */
const MINUTE = 60_000, QUARTER_HOUR = 15 * MINUTE;
/** Bounds an anonymous flood before it reaches routing, authentication or a body parser. */
const anyTraffic = rateLimit({ bucket: 'all', windowMs: MINUTE, perAddress: 1_200 });
/** The health probe: generous enough for any orchestrator, bounded enough not to be an amplifier. */
const healthChecks = rateLimit({ bucket: 'health', windowMs: MINUTE, perAddress: 120 });
const signInFromAddress = rateLimit({ bucket: 'login', windowMs: QUARTER_HOUR, perAddress: 10, message: 'Too many sign-in attempts. Try again later.' });
// Address budgets alone let a botnet grind one account by spreading the attempts; the account keeps
// its own budget across every address they arrive from. It is charged after the body is parsed,
// because the login it is charged to is inside the body.
const signInToAccount = rateLimit({
  bucket: 'login-account', windowMs: QUARTER_HOUR,
  perSubject: { max: 10, key: req => (typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase().slice(0, 128) : 'unknown') },
  message: 'Too many sign-in attempts for this login. Try again later.',
});
const demoSignIn = rateLimit({ bucket: 'demo-login', windowMs: QUARTER_HOUR, perAddress: 60 });
const lookups = rateLimit({ bucket: 'sleeper-lookup', windowMs: MINUTE, perSession: 20, perAddress: 60 });
const recommendations = rateLimit({ bucket: 'recommendation', windowMs: MINUTE, perSession: 30, perAddress: 90 });
const synchronizations = rateLimit({ bucket: 'sync', windowMs: MINUTE, perSession: 10, perAddress: 30 });
// One request here fans out to seven Sleeper endpoints, so it is budgeted well below the other reads.
const leagueDetail = rateLimit({ bucket: 'league-detail', windowMs: MINUTE, perSession: 20, perAddress: 60 });
const dashboards = rateLimit({ bucket: 'dashboard', windowMs: MINUTE, perSession: 120, perAddress: 360 });
const authenticatedTraffic = rateLimit({ bucket: 'api', windowMs: MINUTE, perSession: 600, perAddress: 1_800 });
const accountTraffic = rateLimit({ bucket: 'account', windowMs: MINUTE, perSession: 120, perAddress: 360 });

/**
 * What the application is configured with, rather than what it can read from the environment itself.
 *
 * `validateEnvironment` has already parsed and refused all of this by the time a process builds an
 * application from it, and passing the result in is what stops a second, differently-behaved reader
 * of `WEB_ORIGIN` or `TRUST_PROXY` existing here. The defaults keep `createApp(store)` working for
 * tests, which construct an application without a runtime around it.
 */
export interface AppOptions {
  /** Exact origins allowed to send credentialed requests. */
  webOrigins?: readonly string[];
  /** How many proxies sit in front of this process. See `config/proxy.ts`. */
  trustProxy?: boolean | number | string;
  production?: boolean;
  /** Whether the deployment is reached over TLS, which decides whether HSTS is asserted. */
  https?: boolean;
  log?: Logger;
}

/**
 * What a credential may be, before `scrypt` is asked to spend time on it.
 *
 * The hash is deliberately expensive, so the cost of a sign-in attempt is the length of the password
 * multiplied by that expense. The body limit alone would allow two kilobytes of it.
 */
const MAX_LOGIN = 128, MAX_PASSWORD = 256;

/** The sample league's fiction, which is the same for everyone and exists only outside production. */
const isDemo = (leagueId: string) => leagueId === 'demo' && demoEnabled();
/** The engines answer a demo request from fixtures; a shared cache may keep those for a minute. */
const DEMO_MAX_AGE_SECONDS = 60;

export function createApp(
  store: HuddleRepository,
  sleeper: SleeperClient = sleeperClient('interactive'),
  sync = new LeagueSyncService(store, sleeper),
  signals: WaiverSignalProvider = new FileWaiverSignalProvider(),
  worker = new LeagueSyncWorker(store, sync),
  options: AppOptions = {},
) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origins = options.webOrigins ?? webOrigins();
  const log = options.log ?? processLogger;
  const app = express();
  app.disable('x-powered-by');
  // `req.ip` — which every address budget is charged to — is whatever this says it is.
  app.set('trust proxy', options.trustProxy ?? trustProxySetting());

  /**
   * The order below is the point of it.
   *
   * Identity, headers and the cache default come first so that they are on *every* response,
   * including the ones no route ever sees: a 404 from the router, a 429 from a limiter, a 415 from
   * the body guard, a 500 from the terminal handler. A header applied inside a route is a header
   * missing from every failure.
   *
   * CORS comes before the limiters so that a refusal is still readable by the dashboard. A 429 with
   * no `Access-Control-Allow-Origin` reaches the browser as an opaque CORS failure, and the client
   * shows "something went wrong" instead of the countdown the response is carrying.
   */
  app.use(requestId());
  app.use(securityHeaders({ https: options.https ?? servesHttps() }));
  app.use(noStore());
  app.use(accessLog(log, { quiet: req => req.path === '/health' }));
  app.use(corsPolicy({ origins, production }));
  app.use(guardBody());
  app.use(anyTraffic);

  const players = new PlayerDirectoryService(store, sleeper);
  const commandCenter = new CommandCenterService(store, sync, signals);
  const policy = sessionPolicy();

  /**
   * Liveness, and nothing else.
   *
   * It is the one endpoint anybody can reach without a session, which is exactly why it says so
   * little: not the version, not the environment, not whether the database is reachable, not which
   * upstream is unwell. Each of those is a fact about the deployment that a public endpoint would be
   * publishing to whoever asks, and an orchestrator needs none of them to decide whether to keep
   * routing here.
   *
   * A draining instance reports unhealthy so the load balancer stops sending it new requests while it
   * finishes the ones it already has. It keeps answering them: `server.close()` only stops new
   * connections.
   */
  app.get('/health', healthChecks, (_req, res) => {
    neverStored(res);
    if (isDraining()) return res.status(503).json({ status: 'shutting-down' });
    return res.json({ status: 'ok' });
  });

  /**
   * Sign-in.
   *
   * The address budget is charged before the body is read, so an unauthenticated caller cannot make
   * this process parse and hash for them beyond their allowance. The login and password are bounded
   * here rather than only by the body limit: `scrypt` is deliberately expensive, and a password
   * field the size of the whole body allowance is that expense multiplied by whatever the limit is.
   */
  app.post('/auth/login', signInFromAddress, jsonBody(BODY_LIMITS.credentials), signInToAccount, async (req, res, next) => {
    try {
      const submitted = typeof req.body?.login === 'string' ? req.body.login : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (submitted.length > MAX_LOGIN || password.length > MAX_PASSWORD) throw badRequest('The submitted login or password is longer than this endpoint accepts.', 'invalid_credentials_shape');
      const login = submitted.trim().toLowerCase();
      const user = await store.applicationUserByLogin(login);
      // One message for an unknown login and a wrong password: which of the two it was is a fact
      // about who has an account here.
      if (!await verifyLogin(user, password)) throw new HttpError(401, 'Invalid login or password.', { code: 'invalid_credentials' });
      const issued = await issueSession(store, user!, policy);
      return res.append('Set-Cookie', sessionCookie(issued.rawSessionId, issued.maxAge))
        .json({ user: publicUser(user!), csrfToken: issued.csrfToken, expiresAt: issued.session.expiresAt });
    } catch (error) { return next(error); }
  });

  app.post('/auth/demo', demoSignIn, async (_req, res, next) => {
    try {
      if (!demoEnabled()) throw notFound('Not found.');
      let user = await store.applicationUserByLogin('demo');
      if (!user) {
        user = { id: randomUUID(), login: 'demo', passwordHash: 'disabled', sleeperUserId: 'sample', sleeperUsername: 'sample', sleeperLeagueIds: ['demo', '1234'], createdAt: new Date().toISOString() };
        await store.saveApplicationUser(user);
      }
      const issued = await issueSession(store, user, policy);
      return res.append('Set-Cookie', sessionCookie(issued.rawSessionId, issued.maxAge))
        .json({ user: publicUser(user), csrfToken: issued.csrfToken, expiresAt: issued.session.expiresAt });
    } catch (error) { return next(error); }
  });

  const requireAuth = authentication(store, policy);
  // Restores a reloaded page from its cookie alone: the CSRF token only ever lives in the client's memory,
  // so a fresh one is issued here rather than replayed, and existing tabs keep the tokens they already hold.
  app.get('/auth/session', requireAuth, accountTraffic, async (_req, res, next) => {
    try { const auth = res.locals.auth as Authentication; res.json({ user: publicUser(auth.user), csrfToken: await issueCsrfToken(store, auth.session), expiresAt: auth.session.expiresAt }); }
    catch (error) { next(error); }
  });
  app.post('/auth/logout', requireAuth, accountTraffic, csrf, async (_req, res, next) => {
    try { const auth = res.locals.auth as Authentication; await store.revokeSessionFamily(auth.session.familyId, 'logout'); res.append('Set-Cookie', clearSessionCookie()).status(204).end(); }
    catch (error) { next(error); }
  });
  app.post('/auth/logout-all', requireAuth, accountTraffic, csrf, async (_req, res, next) => {
    try { const auth = res.locals.auth as Authentication; await store.revokeUserSessions(auth.user.id, 'logout-all'); res.append('Set-Cookie', clearSessionCookie()).status(204).end(); }
    catch (error) { next(error); }
  });
  app.post('/auth/rotate', requireAuth, accountTraffic, csrf, async (_req, res, next) => {
    try {
      const auth = res.locals.auth as Authentication;
      const rotated = await rotateSession(store, auth.session, policy);
      res.append('Set-Cookie', sessionCookie(rotated.rawSessionId, rotated.maxAge)).json({ csrfToken: await issueCsrfToken(store, rotated.session), expiresAt: rotated.session.expiresAt });
    } catch (error) { next(error); }
  });

  app.use('/api', requireAuth); app.use('/api', csrf); app.use('/api', authenticatedTraffic);

  app.post('/api/account/sleeper', lookups, jsonBody(BODY_LIMITS.accountLink), async (req, res, next) => {
    try {
      // Both fields go through the shared rules before anything is sent upstream, so what can be
      // linked here and what can be requested by path are one definition rather than two that drift.
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      if (!username) throw badRequest('A Sleeper username is required.', 'username_required');
      fields.sleeperUsername.parse(username, 'username');
      const submitted: unknown = req.body?.leagueIds;
      if (submitted !== undefined && !Array.isArray(submitted)) throw badRequest("'leagueIds' must be an array of Sleeper league ids.", 'invalid_league_ids');
      const requested = (submitted ?? []) as unknown[];
      if (requested.length > 50) throw badRequest('Link at most 50 leagues at once.', 'too_many_leagues');
      const leagueIds = requested.map(id => {
        if (typeof id !== 'string') throw badRequest("'leagueIds' must be an array of Sleeper league ids.", 'invalid_league_ids');
        return fields.leagueId.parse(id, 'leagueIds');
      });
      const sleeperUser = await sleeper.user(username);
      if (!sleeperUser) throw notFound('Sleeper user not found.');
      if (leagueIds.length) {
        const year = new Date().getUTCFullYear();
        const available = (await Promise.all([year, year - 1, year - 2].map(season => sleeper.leagues(sleeperUser.user_id, season)))).flat();
        const allowed = new Set(available.map(league => league.league_id));
        if (leagueIds.some(id => !allowed.has(id))) throw forbidden('A selected league does not belong to the claimed Sleeper account.');
      }
      const auth = res.locals.auth as Authentication;
      const updated = { ...auth.user, sleeperUserId: sleeperUser.user_id, sleeperUsername: sleeperUser.username, sleeperLeagueIds: [...new Set(leagueIds)] };
      await store.saveApplicationUser(updated);
      // The connection set follows the linked accounts, and a newly linked league is queued rather than
      // waiting up to a full interval for its first synchronization.
      await store.reconcileLeagueConnections();
      for (const id of updated.sleeperLeagueIds) worker.enqueue(id, { reason: 'connect' });
      res.json({ user: publicUser(updated), verification: 'claimed' });
    } catch (error) { next(error); }
  });

  /**
   * Every `:leagueId` in the API, checked for shape and then for ownership.
   *
   * The order matters: a malformed id is a 400 and an id belonging to someone else is a 403, so the
   * status never implies that an id the caller invented is real.
   */
  app.param('leagueId', (req, res, next, value) => {
    try {
      const leagueId = fields.leagueId.parse(String(value), 'leagueId');
      const user = (res.locals.auth as Authentication).user;
      if (isDemo(leagueId)) return next();
      if (!user.sleeperLeagueIds.includes(leagueId)) throw forbidden('This league is not linked to the authenticated account.');
      return next();
    } catch (error) { return next(error); }
  });

  app.get('/api/command-center/:leagueId', recommendations, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: fields.week, ...tradeBoundFields });
      // `parseTradeBounds` stays the authority on what a bound may be; the schema above refuses the
      // shapes it would have to throw on, so the two agree by construction rather than by comment.
      const bounds = parseTradeBounds(suppliedBounds(parsed));
      res.json(await commandCenter.load((res.locals.auth as Authentication).user, leagueId, parsed.week, bounds));
    } catch (error) { return next(error); }
  });

  app.get('/api/trades/:leagueId', recommendations, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: optional(fields.week), force: optional(fields.force), format: optional(fields.leagueFormat), ...tradeBoundFields });
      const bounds = parseTradeBounds(suppliedBounds(parsed));
      if (isDemo(leagueId)) return publicCached(res, DEMO_MAX_AGE_SECONDS).json(recommendTrades({ ...demoTradeInput(new Date(), parsed.format === 'dynasty'), bounds }));
      const week = parsed.week, userId = (res.locals.auth as Authentication).user.sleeperUserId;
      if (week === undefined || !userId) throw badRequest('Link a Sleeper account and provide an integer week from 1 to 18.', 'week_required');
      // A forced refresh is queued for the worker rather than run here: this request answers from the
      // last good snapshot, and the fan-out happens under the worker's concurrency limit and its locks.
      // The cached synchronization below stays inline — it is bounded by REFRESH_AFTER_MS and usually
      // fetches nothing at all.
      if (parsed.force) worker.enqueue(leagueId, { reason: 'manual', force: true, week });
      try { await sync.syncLeague(leagueId, week); } catch (error) {
        if ((await store.league(leagueId))?.scoring?.kind !== 'unavailable') throw error;
      }
      const context = await store.tradeContext(leagueId);
      if (!context.league) throw notFound('League not synced.');
      const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
      if (!roster) throw forbidden('This account does not own or co-own a roster in the selected league.');
      let forecast = null;
      try { forecast = await signals.load(context.league.season, week); } catch { /* Report unavailable without leaking provider paths. */ }
      return res.json(recommendTrades({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast, bounds }));
    } catch (error) { return next(error); }
  });

  app.get('/api/lineup/:leagueId', recommendations, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: optional(fields.week), force: optional(fields.force) });
      if (isDemo(leagueId)) return publicCached(res, DEMO_MAX_AGE_SECONDS).json(analyzeLineup(demoLineupInput()));
      const week = parsed.week, userId = (res.locals.auth as Authentication).user.sleeperUserId;
      if (week === undefined || !userId) throw badRequest('Link a Sleeper account and provide an integer week from 1 to 18.', 'week_required');
      if (parsed.force) worker.enqueue(leagueId, { reason: 'manual', force: true, week });
      try { await sync.syncLeague(leagueId, week); } catch (error) {
        if ((await store.league(leagueId))?.scoring?.kind !== 'unavailable') throw error;
      }
      const league = await store.league(leagueId);
      if (!league) throw notFound('League not synced.');
      const context = await store.lineupContext(leagueId, league.season, week);
      const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
      if (!roster) throw forbidden('This account does not own or co-own a roster in the selected league.');
      let forecast = null;
      let sourceError = false;
      try { forecast = await signals.load(league.season, week); } catch { sourceError = true; }
      const report = analyzeLineup({ ...context, league, rosterId: roster.rosterId, week, signals: forecast });
      if (sourceError) report.warnings.push('The forecast source could not be loaded or failed validation. Lineup analysis is unavailable until the source is repaired.');
      return res.json(report);
    } catch (error) { return next(error); }
  });

  app.get('/api/waivers/:leagueId', recommendations, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: optional(fields.week), force: optional(fields.force) });
      if (isDemo(leagueId)) return publicCached(res, DEMO_MAX_AGE_SECONDS).json(recommendWaivers(demoWaiverInput()));
      const week = parsed.week, userId = (res.locals.auth as Authentication).user.sleeperUserId;
      if (week === undefined || !userId) throw badRequest('Link a Sleeper account and provide an integer week from 1 to 18.', 'week_required');
      if (parsed.force) worker.enqueue(leagueId, { reason: 'manual', force: true, week });
      try { await sync.syncLeague(leagueId, week); } catch (error) {
        if ((await store.league(leagueId))?.scoring?.kind !== 'unavailable') throw error;
      }
      const context = await store.waiverContext(leagueId);
      if (!context.league) throw notFound('League not synced.');
      const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
      if (!roster) throw forbidden('This account does not own or co-own a roster in the selected league.');
      let forecast = null;
      let sourceError = false;
      try { forecast = await signals.load(context.league.season, week); } catch { sourceError = true; }
      const report = recommendWaivers({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast });
      if (sourceError) report.warnings.push('The forecast source could not be loaded or failed validation. Rankings are unavailable until the source is repaired.');
      return res.json(report);
    } catch (error) { return next(error); }
  });

  app.get('/api/dashboard/:leagueId', dashboards, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      query(req, {});
      let data = await store.snapshot(leagueId);
      if (!data && isDemo(leagueId)) { data = demoSnapshot(); await store.save(data); }
      if (!data) throw notFound('League not synced');
      if (isDemo(leagueId)) return publicCached(res, DEMO_MAX_AGE_SECONDS).json(data);
      return res.json({ ...data, scoring: (await store.league(leagueId))?.scoring ?? scoringUnavailable(), recommendations: [] });
    } catch (error) { return next(error); }
  });

  /**
   * Manual refresh.
   *
   * The request queues the same job the scheduler runs and returns immediately. Synchronizing a league
   * inline would mean a browser waiting on up to seven upstream calls, with as many of those fan-outs in
   * flight as there are people pressing the button — precisely the load the worker exists to bound. The
   * response carries the queue position and the last recorded outcome so the client can report progress,
   * and the dashboard keeps serving the last good snapshot throughout.
   */
  app.post('/api/sync/:leagueId', synchronizations, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: optional(fields.week), force: optional(fields.force) });
      if (isDemo(leagueId)) { const data = demoSnapshot(); await store.save(data); return res.json(data); }
      await store.connectLeague(leagueId, { season: (await store.league(leagueId))?.season ?? null, ...(parsed.week !== undefined ? { week: parsed.week } : {}) });
      const job = worker.enqueue(leagueId, { reason: 'manual', force: parsed.force === true, week: parsed.week });
      return res.status(202).json(await syncState(store, worker, leagueId, job));
    } catch (error) { return next(error); }
  });

  /** Progress for a queued refresh, and why a snapshot is as old as it is when one is failing. */
  app.get('/api/sync/:leagueId', dashboards, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      query(req, {});
      if (isDemo(leagueId)) return res.json({ leagueId, queued: false, running: false, demo: true, lastSyncedAt: (await store.snapshot('demo'))?.lastSyncedAt ?? null });
      return res.json(await syncState(store, worker, leagueId));
    } catch (error) { return next(error); }
  });

  app.get('/api/sleeper/users/:username', lookups, async (req, res, next) => {
    try {
      const username = param(req, 'username', fields.sleeperUsername);
      query(req, {});
      const user = await sleeper.user(username);
      if (!user) throw notFound('No Sleeper account was found for that username.');
      res.json(user);
    } catch (error) { next(error); }
  });

  app.get('/api/sleeper/users/:userId/leagues', lookups, async (req, res, next) => {
    try {
      const userId = param(req, 'userId', fields.sleeperUserId);
      const parsed = query(req, { seasons: optional(fields.seasons) });
      const linked = (res.locals.auth as Authentication).user.sleeperUserId;
      // The identity comes from the session, never from the path: the path is only allowed to name
      // the account the session already established.
      if (userId !== linked) throw forbidden('Only the linked Sleeper account may be queried.');
      const current = new Date().getUTCFullYear();
      const seasons = parsed.seasons ?? [current, current - 1, current - 2].map(String);
      const results = await Promise.all(seasons.map(async season => ({ season, leagues: await sleeper.leagues(userId, season) })));
      res.json({ seasons: results, lastSyncedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  // Authenticated responses may be stored only in a private browser cache and must revalidate.
  // Express generates content ETags and honors If-None-Match after authentication/authorization.
  app.get('/api/players/:leagueId', dashboards, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const requested = playerSelection(req);
      const selection = requested ?? { ids: (await store.rosters(leagueId)).flatMap(r => [...r.playerIds, ...r.starterIds, ...r.reserveIds, ...r.taxiIds]) };
      await players.prepareRead();
      privateRevalidated(res).json(await players.subset(selection));
    } catch (error) { next(error); }
  });

  app.get('/api/sleeper/leagues/:leagueId', leagueDetail, async (req, res, next) => {
    try {
      const leagueId = param(req, 'leagueId', fields.leagueId);
      const parsed = query(req, { week: withDefault(fields.week, 1), round: optional(fields.round) });
      const week = parsed.week, round = parsed.round ?? week;
      const [league, rosters, users, matchups, transactions, drafts, tradedPicks] = await Promise.all([
        sync.synchronizeLeagueMetadata(leagueId), sleeper.rosters(leagueId), sleeper.leagueUsers(leagueId),
        sleeper.matchups(leagueId, week), sleeper.transactions(leagueId, round), sleeper.drafts(leagueId), sleeper.tradedPicks(leagueId), players.prepareRead(),
      ]);
      const availability = await players.subset({ ids: leaguePlayerIds(rosters, matchups, transactions) });
      privateRevalidated(res).json({ league, scoring: (await store.league(leagueId))?.scoring, rosters, users, matchups, transactions, drafts, tradedPicks, ...availability, lastSyncedAt: new Date().toISOString() });
    } catch (error) { next(error); }
  });

  // Anything that reached neither a route nor a handler, answered in the API's own shape.
  app.use(notFoundHandler());
  app.use(errorHandler(log));
  return app;
}
