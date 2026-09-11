import { CommandCenterService, DashboardAccessError } from './command-center.js';
import { scoringUnavailable } from '@sleeper/domain';
import express from 'express'; import cors from 'cors'; import { SleeperApiError, SleeperClient } from '@sleeper/sleeper-client'; import { demoSnapshot } from './demo.js'; import type { HuddleRepository } from './storage/repositories.js';
import { LeagueSyncService } from './sync.js';
import { PlayerDirectoryService, leaguePlayerIds, validPlayerId } from './players.js';
import { LeagueSyncWorker, type QueuedSyncJob } from './scheduler/index.js';
import { FileWaiverSignalProvider, type WaiverSignalProvider } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './waiver-demo.js';
import { parseTradeBounds, recommendTrades } from './trades.js';
import { demoTradeInput } from './trade-demo.js';
import { analyzeLineup } from './lineup.js';
import { randomUUID } from 'node:crypto';
import { authentication, clearSessionCookie, csrf, demoEnabled, issueCsrfToken, issueSession, rotateSession, sessionCookie, sessionPolicy, verifyLogin, type Authentication } from './auth.js';
import { bySession, rateLimit, trustProxySetting } from './rate-limit.js';
import { webOrigins } from './config/origins.js';
import { isDraining } from './lifecycle.js';
import { demoLineupInput } from './lineup-demo.js';
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
const signIn=rateLimit({bucket:'login',max:10,windowMs:15*60_000,message:'Too many sign-in attempts. Try again later.'});
// Address budgets alone let a botnet grind one account; the account keeps its own budget across every address.
const signInToAccount=rateLimit({bucket:'login-account',max:10,windowMs:15*60_000,key:req=>typeof req.body?.login==='string'?req.body.login.trim().toLowerCase():'unknown',message:'Too many sign-in attempts for this login. Try again later.'});
const lookups=rateLimit({bucket:'sleeper-lookup',max:20,windowMs:60_000,key:bySession});
const recommendations=rateLimit({bucket:'recommendation',max:30,windowMs:60_000,key:bySession});
const synchronizations=rateLimit({bucket:'sync',max:10,windowMs:60_000,key:bySession});
// One request here fans out to seven Sleeper endpoints, so it is budgeted well below the other reads.
const leagueDetail=rateLimit({bucket:'league-detail',max:20,windowMs:60_000,key:bySession});
const dashboards=rateLimit({bucket:'dashboard',max:120,windowMs:60_000,key:bySession});
const authenticatedTraffic=rateLimit({bucket:'api',max:600,windowMs:60_000,key:bySession});
const accountTraffic=rateLimit({bucket:'account',max:120,windowMs:60_000,key:bySession});
export function createApp(store: HuddleRepository, sleeper = new SleeperClient(), sync = new LeagueSyncService(store, sleeper), signals: WaiverSignalProvider = new FileWaiverSignalProvider(), worker = new LeagueSyncWorker(store, sync)) { const app=express(); app.disable('x-powered-by'); app.set('trust proxy',trustProxySetting()); app.use(cors({origin:webOrigins(), credentials:true})); app.use(express.json({limit:'32kb'}));
 const players = new PlayerDirectoryService(store, sleeper);
 const commandCenter = new CommandCenterService(store, sync, signals);
 const policy=sessionPolicy();
 // A draining instance reports unhealthy so the load balancer stops sending it new requests while it
 // finishes the ones it already has. It keeps answering them: `server.close()` only stops new connections.
 app.get('/health',(_req,res)=>isDraining()?res.status(503).json({status:'shutting-down'}):res.json({status:'ok'}));
 app.post('/auth/login', signIn, signInToAccount, async(req,res)=>{const login=typeof req.body?.login==='string'?req.body.login.trim().toLowerCase():'';const password=typeof req.body?.password==='string'?req.body.password:'';const user=await store.applicationUserByLogin(login);if(!await verifyLogin(user,password))return res.status(401).json({error:'Invalid login or password.'});const issued=await issueSession(store,user!,policy);res.append('Set-Cookie',sessionCookie(issued.rawSessionId,issued.maxAge)).json({user:publicUser(user!),csrfToken:issued.csrfToken,expiresAt:issued.session.expiresAt});});
 app.post('/auth/demo', rateLimit({bucket:'demo-login',max:60,windowMs:15*60_000}), async(_req,res)=>{if(!demoEnabled())return res.status(404).json({error:'Not found.'});let user=await store.applicationUserByLogin('demo');if(!user){user={id:randomUUID(),login:'demo',passwordHash:'disabled',sleeperUserId:'sample',sleeperUsername:'sample',sleeperLeagueIds:['demo','1234'],createdAt:new Date().toISOString()};await store.saveApplicationUser(user);}const issued=await issueSession(store,user,policy);res.append('Set-Cookie',sessionCookie(issued.rawSessionId,issued.maxAge)).json({user:publicUser(user),csrfToken:issued.csrfToken,expiresAt:issued.session.expiresAt});});
 const requireAuth=authentication(store,policy);
 // Restores a reloaded page from its cookie alone: the CSRF token only ever lives in the client's memory,
 // so a fresh one is issued here rather than replayed, and existing tabs keep the tokens they already hold.
 app.get('/auth/session',requireAuth,accountTraffic,async(_req,res)=>{const auth=res.locals.auth as Authentication;res.json({user:publicUser(auth.user),csrfToken:await issueCsrfToken(store,auth.session),expiresAt:auth.session.expiresAt});});
 app.post('/auth/logout',requireAuth,accountTraffic,csrf,async(_req,res)=>{const auth=res.locals.auth as Authentication;await store.revokeSessionFamily(auth.session.familyId,'logout');res.append('Set-Cookie',clearSessionCookie()).status(204).end();});
 app.post('/auth/logout-all',requireAuth,accountTraffic,csrf,async(_req,res)=>{const auth=res.locals.auth as Authentication;await store.revokeUserSessions(auth.user.id,'logout-all');res.append('Set-Cookie',clearSessionCookie()).status(204).end();});
 app.post('/auth/rotate',requireAuth,accountTraffic,csrf,async(_req,res)=>{const auth=res.locals.auth as Authentication;const rotated=await rotateSession(store,auth.session,policy);res.append('Set-Cookie',sessionCookie(rotated.rawSessionId,rotated.maxAge)).json({csrfToken:await issueCsrfToken(store,rotated.session),expiresAt:rotated.session.expiresAt});});
 app.use('/api',requireAuth); app.use('/api',csrf); app.use('/api',authenticatedTraffic);
 app.post('/api/account/sleeper',lookups,async(req,res,next)=>{try{const username=typeof req.body?.username==='string'?req.body.username.trim():'';const leagueIds:string[]=Array.isArray(req.body?.leagueIds)?req.body.leagueIds.filter((id:unknown):id is string=>typeof id==='string').slice(0,50):[];if(!username)return res.status(400).json({error:'A Sleeper username is required.'});const sleeperUser=await sleeper.user(username);if(!sleeperUser)return res.status(404).json({error:'Sleeper user not found.'});if(leagueIds.length){const year=new Date().getUTCFullYear();const available=(await Promise.all([year,year-1,year-2].map(season=>sleeper.leagues(sleeperUser.user_id,season)))).flat();const allowed=new Set(available.map(league=>league.league_id));if(leagueIds.some(id=>!allowed.has(id)))return res.status(403).json({error:'A selected league does not belong to the claimed Sleeper account.'});}const auth=res.locals.auth as Authentication;const updated={...auth.user,sleeperUserId:sleeperUser.user_id,sleeperUsername:sleeperUser.username,sleeperLeagueIds:[...new Set(leagueIds)]};await store.saveApplicationUser(updated);
   // The connection set follows the linked accounts, and a newly linked league is queued rather than
   // waiting up to a full interval for its first synchronization.
   await store.reconcileLeagueConnections();
   for(const id of updated.sleeperLeagueIds) worker.enqueue(id,{reason:'connect'});
   res.json({user:publicUser(updated),verification:'claimed'});}catch(error){next(error);}});

 app.param('leagueId',(req,res,next,value)=>{const user=(res.locals.auth as Authentication).user;if(value==='demo'&&demoEnabled())return next();if(!user.sleeperLeagueIds.includes(value))return res.status(403).json({error:'This league is not linked to the authenticated account.'});next();});
 app.get('/api/command-center/:leagueId', recommendations, async (req, res, next) => {
   try {
     const week = typeof req.query.week === 'string' ? Number(req.query.week) : NaN;
     let bounds;
     try {
       bounds = parseTradeBounds(Object.fromEntries(Object.entries(req.query).filter(([key]) => key !== 'week').map(([key, value]) => {
         if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid bound.');
         return [key, Number(value)];
       })));
     } catch { return res.status(400).json({ error: 'Invalid trade bounds.' }); }
     res.set('Cache-Control', 'private, no-store');
     res.json(await commandCenter.load((res.locals.auth as Authentication).user, String(req.params.leagueId), week, bounds));
   } catch (error) {
     if (error instanceof DashboardAccessError) return res.status(error.status).json({ error: error.message });
     next(error);
   }
 });
 app.get('/api/trades/:leagueId',recommendations, async (req, res, next) => {
   try {
     let bounds;
     try {
       const requested = Object.fromEntries(Object.entries(req.query).filter(([key]) => !['week', 'force', 'format'].includes(key)).map(([key, value]) => {
         if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid bound.');
         return [key, Number(value)];
       }));
       bounds = parseTradeBounds(requested);
     } catch { return res.status(400).json({ error: 'Invalid trade bounds. Use numeric fairness/risk fractions from 0 to 1 and documented search limits.' }); }
     if (String(req.params.leagueId) === 'demo' && demoEnabled()) return res.json(recommendTrades({ ...demoTradeInput(new Date(), req.query.format === 'dynasty'), bounds }));
     const week = Number(req.query.week), userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (typeof req.query.week !== 'string' || !Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     // A forced refresh is queued for the worker rather than run here: this request answers from the
     // last good snapshot, and the fan-out happens under the worker's concurrency limit and its locks.
     // The cached synchronization below stays inline — it is bounded by REFRESH_AFTER_MS and usually
     // fetches nothing at all.
     if (req.query.force === 'true') worker.enqueue(String(req.params.leagueId), { reason: 'manual', force: true, week });
     try { await sync.syncLeague(String(req.params.leagueId), week); } catch (error) {
       if ((await store.league(String(req.params.leagueId)))?.scoring?.kind !== 'unavailable') throw error;
     }
     const context = await store.tradeContext(String(req.params.leagueId));
     if (!context.league) return res.status(404).json({ error: 'League not synced.' });
     const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
     if (!roster) return res.status(403).json({ error: 'This account does not own or co-own a roster in the selected league.' });
     let forecast = null;
     try { forecast = await signals.load(context.league.season, week); } catch { /* Report unavailable without leaking provider paths. */ }
     return res.json(recommendTrades({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast, bounds }));
   } catch (error) { next(error); }
 });
 app.get('/api/lineup/:leagueId',recommendations, async (req, res, next) => {
   try {
     if (String(req.params.leagueId) === 'demo' && demoEnabled()) return res.json(analyzeLineup(demoLineupInput()));
     const week = Number(req.query.week), userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (typeof req.query.week !== 'string' || !Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     // A forced refresh is queued for the worker rather than run here: this request answers from the
     // last good snapshot, and the fan-out happens under the worker's concurrency limit and its locks.
     // The cached synchronization below stays inline — it is bounded by REFRESH_AFTER_MS and usually
     // fetches nothing at all.
     if (req.query.force === 'true') worker.enqueue(String(req.params.leagueId), { reason: 'manual', force: true, week });
     try { await sync.syncLeague(String(req.params.leagueId), week); } catch (error) {
       if ((await store.league(String(req.params.leagueId)))?.scoring?.kind !== 'unavailable') throw error;
     }
     const league = await store.league(String(req.params.leagueId));
     if (!league) return res.status(404).json({ error: 'League not synced.' });
     const context = await store.lineupContext(String(req.params.leagueId), league.season, week);
     const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
     if (!roster) return res.status(403).json({ error: 'This account does not own or co-own a roster in the selected league.' });
     let forecast = null;
     let sourceError = false;
     try { forecast = await signals.load(league.season, week); } catch { sourceError = true; }
     const report = analyzeLineup({ ...context, league, rosterId: roster.rosterId, week, signals: forecast });
     if (sourceError) report.warnings.push('The forecast source could not be loaded or failed validation. Lineup analysis is unavailable until the source is repaired.');
     return res.json(report);
   } catch (error) { next(error); }
 });
 app.get('/api/waivers/:leagueId',recommendations, async (req, res, next) => {
   try {
     if (String(req.params.leagueId) === 'demo' && demoEnabled()) return res.json(recommendWaivers(demoWaiverInput()));
     const week = Number(req.query.week);
     const userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (!Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     // A forced refresh is queued for the worker rather than run here: this request answers from the
     // last good snapshot, and the fan-out happens under the worker's concurrency limit and its locks.
     // The cached synchronization below stays inline — it is bounded by REFRESH_AFTER_MS and usually
     // fetches nothing at all.
     if (req.query.force === 'true') worker.enqueue(String(req.params.leagueId), { reason: 'manual', force: true, week });
     try { await sync.syncLeague(String(req.params.leagueId), week); } catch (error) {
       if ((await store.league(String(req.params.leagueId)))?.scoring?.kind !== 'unavailable') throw error;
     }
     const context = await store.waiverContext(String(req.params.leagueId));
     if (!context.league) return res.status(404).json({ error: 'League not synced.' });
     const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
     if (!roster) return res.status(403).json({ error: 'This account does not own or co-own a roster in the selected league.' });
     let forecast = null;
     let sourceError = false;
     try { forecast = await signals.load(context.league.season, week); } catch { sourceError = true; }
     const report = recommendWaivers({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast });
     if (sourceError) report.warnings.push('The forecast source could not be loaded or failed validation. Rankings are unavailable until the source is repaired.');
     return res.json(report);
   } catch (error) { next(error); }
 });
 app.get('/api/dashboard/:leagueId',dashboards,async(req,res)=>{let data=await store.snapshot(String(req.params.leagueId)); if(!data&&String(req.params.leagueId)==='demo'&&demoEnabled()){data=demoSnapshot();await store.save(data);} if(!data)return res.status(404).json({error:'League not synced'});res.json(String(req.params.leagueId) === 'demo' && demoEnabled() ? data : { ...data, scoring: (await store.league(String(req.params.leagueId)))?.scoring ?? scoringUnavailable(), recommendations: [] });});
 /**
  * Manual refresh.
  *
  * The request queues the same job the scheduler runs and returns immediately. Synchronizing a league
  * inline would mean a browser waiting on up to seven upstream calls, with as many of those fan-outs in
  * flight as there are people pressing the button — precisely the load the worker exists to bound. The
  * response carries the queue position and the last recorded outcome so the client can report progress,
  * and the dashboard keeps serving the last good snapshot throughout.
  */
 app.post('/api/sync/:leagueId',synchronizations,async(req,res,next)=>{try{
   const leagueId=String(req.params.leagueId);
   if(leagueId==='demo'&&demoEnabled()){const data=demoSnapshot();await store.save(data);return res.json(data);}
   const requested=Number(req.query.week);
   const week=Number.isInteger(requested)&&requested>=1&&requested<=18?requested:undefined;
   await store.connectLeague(leagueId,{season:(await store.league(leagueId))?.season??null,...(week!==undefined?{week}:{})});
   const job=worker.enqueue(leagueId,{reason:'manual',force:req.query.force==='true',week});
   res.status(202).json(await syncState(store,worker,leagueId,job));
 }catch(error){next(error);}});
 /** Progress for a queued refresh, and why a snapshot is as old as it is when one is failing. */
 app.get('/api/sync/:leagueId',dashboards,async(req,res,next)=>{try{
   const leagueId=String(req.params.leagueId);
   if(leagueId==='demo'&&demoEnabled())return res.json({leagueId,queued:false,running:false,demo:true,lastSyncedAt:(await store.snapshot('demo'))?.lastSyncedAt??null});
   res.json(await syncState(store,worker,leagueId));
 }catch(error){next(error);}});
 app.get('/api/sleeper/users/:username',lookups,async(req,res,next)=>{try{const user=await sleeper.user(String(req.params.username));if(!user)return res.status(404).json({error:'No Sleeper account was found for that username.'});res.json(user);}catch(error){next(error);}});
 app.get('/api/sleeper/users/:userId/leagues',lookups,async(req,res,next)=>{try{const linked=(res.locals.auth as Authentication).user.sleeperUserId;if(String(req.params.userId)!==linked)return res.status(403).json({error:'Only the linked Sleeper account may be queried.'});const current=new Date().getUTCFullYear();const requested=typeof req.query.seasons==='string'?req.query.seasons.split(','):[current,current-1,current-2].map(String);const seasons=requested.filter(season=>/^\d{4}$/.test(season)).slice(0,6);if(!seasons.length)return res.status(400).json({error:'Provide at least one valid season.'});const results=await Promise.all(seasons.map(async season=>({season,leagues:await sleeper.leagues(String(req.params.userId),season)})));res.json({seasons:results,lastSyncedAt:new Date().toISOString()});}catch(error){next(error);}});
 // Authenticated responses may be stored only in a private browser cache and must revalidate.
 // Express generates content ETags and honors If-None-Match after authentication/authorization.
 app.get('/api/players/:leagueId',dashboards,async(req,res,next)=>{try{
   const ids = req.query.ids, query = req.query.q;
   const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
   if (ids !== undefined && query !== undefined) return res.status(400).json({error:'Choose IDs or a name search.'});
   if (ids !== undefined && (typeof ids !== 'string' || ids.split(',').length > 100 || !ids.split(',').every(validPlayerId))) return res.status(400).json({error:'Provide 1 to 100 valid player IDs.'});
   if (query !== undefined && (typeof query !== 'string' || query.trim().length < 2 || query.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 50)) return res.status(400).json({error:'Provide a search of 2 to 100 characters and a limit from 1 to 50.'});
   const selection = typeof ids === 'string' ? {ids:ids.split(',')} : typeof query === 'string' ? {query:query.trim(),limit}
     : {ids:(await store.rosters(String(req.params.leagueId))).flatMap(r=>[...r.playerIds,...r.starterIds,...r.reserveIds,...r.taxiIds])};
   await players.prepareRead();
   res.set('Cache-Control','private, no-cache').vary('Cookie').json(await players.subset(selection));
 }catch(error){next(error);}});
 app.get('/api/sleeper/leagues/:leagueId',leagueDetail,async(req,res,next)=>{try{
   const leagueId=String(req.params.leagueId);
   const week=Math.max(1,Number(req.query.week)||1), round=Math.max(1,Number(req.query.round)||week);
   const [league,rosters,users,matchups,transactions,drafts,tradedPicks]=await Promise.all([
     sync.synchronizeLeagueMetadata(leagueId),sleeper.rosters(leagueId),sleeper.leagueUsers(leagueId),
     sleeper.matchups(leagueId,week),sleeper.transactions(leagueId,round),sleeper.drafts(leagueId),sleeper.tradedPicks(leagueId),players.prepareRead(),
   ]);
   const availability = await players.subset({ids:leaguePlayerIds(rosters,matchups,transactions)});
   res.set('Cache-Control','private, no-cache').vary('Cookie').json({league,scoring:(await store.league(leagueId))?.scoring,rosters,users,matchups,transactions,drafts,tradedPicks,...availability,lastSyncedAt:new Date().toISOString()});
 }catch(error){next(error);}});
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{const status=error instanceof SleeperApiError&&error.status===404?404:502;res.status(status).json({error:status===404?'Sleeper resource not found.':'Sleeper is unavailable right now. Please try again.',category:error instanceof SleeperApiError?error.category:'internal'});});
 return app; }
