import { scoringUnavailable } from '@sleeper/domain';
import express from 'express'; import cors from 'cors'; import { SleeperApiError, SleeperClient } from '@sleeper/sleeper-client'; import { demoSnapshot } from './demo.js'; import type { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';
import { FileWaiverSignalProvider, type WaiverSignalProvider } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './waiver-demo.js';
import { parseTradeBounds, recommendTrades } from './trades.js';
import { demoTradeInput } from './trade-demo.js';
import { analyzeLineup } from './lineup.js';
import { randomUUID } from 'node:crypto';
import { authentication, clearSessionCookie, csrf, issueSession, passwordMatches, sessionCookie, type Authentication } from './auth.js';
import { demoLineupInput } from './lineup-demo.js';
const limits = new Map<string,{start:number,count:number}>();
function rateLimit(bucket:string,max:number,windowMs:number){return (req:express.Request,res:express.Response,next:express.NextFunction)=>{const key=`${bucket}:${req.ip}`;const now=Date.now();let value=limits.get(key);if(!value||now-value.start>=windowMs)value={start:now,count:0};value.count++;limits.set(key,value);res.set('RateLimit-Limit',String(max));res.set('RateLimit-Remaining',String(Math.max(0,max-value.count)));if(value.count>max)return res.status(429).set('Retry-After',String(Math.ceil((value.start+windowMs-now)/1000))).json({error:'Too many requests. Try again later.'});next();};}
function publicUser(user: import('./store.js').ApplicationUser){return {id:user.id,login:user.login,sleeperUserId:user.sleeperUserId,sleeperUsername:user.sleeperUsername,sleeperLeagueIds:user.sleeperLeagueIds};}
export function createApp(store: JsonStore, sleeper = new SleeperClient(), sync = new LeagueSyncService(store, sleeper), signals: WaiverSignalProvider = new FileWaiverSignalProvider()) { const app=express(); app.disable('x-powered-by'); app.use(cors({origin:process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials:true})); app.use(express.json({limit:'32kb'}));
 app.get('/health',(_req,res)=>res.json({status:'ok'}));
 app.post('/auth/login', rateLimit('login', 10, 15*60_000), async(req,res)=>{const login=typeof req.body?.login==='string'?req.body.login.trim().toLowerCase():'';const password=typeof req.body?.password==='string'?req.body.password:'';const user=await store.applicationUserByLogin(login);if(!user||!await passwordMatches(password,user.passwordHash))return res.status(401).json({error:'Invalid login or password.'});const issued=await issueSession(store,user);res.set('Set-Cookie',sessionCookie(issued.rawSessionId,issued.maxAge)).json({user:publicUser(user),csrfToken:issued.csrfToken,expiresAt:issued.session.expiresAt});});
 app.post('/auth/demo', rateLimit('demo-login', 10, 15*60_000), async(_req,res)=>{if(process.env.NODE_ENV==='production'||process.env.ENABLE_DEMO_AUTH!=='true')return res.status(404).json({error:'Not found.'});let user=await store.applicationUserByLogin('demo');if(!user){user={id:randomUUID(),login:'demo',passwordHash:'disabled',sleeperUserId:'sample',sleeperUsername:'sample',sleeperLeagueIds:['demo','1234'],createdAt:new Date().toISOString()};await store.saveApplicationUser(user);}const issued=await issueSession(store,user);res.set('Set-Cookie',sessionCookie(issued.rawSessionId,issued.maxAge)).json({user:publicUser(user),csrfToken:issued.csrfToken,expiresAt:issued.session.expiresAt});});
 const requireAuth=authentication(store);
 app.get('/auth/session',requireAuth,(req,res)=>{const auth=res.locals.auth as Authentication;res.json({user:publicUser(auth.user),csrfToken:undefined,expiresAt:auth.session.expiresAt});});
 app.post('/auth/logout',requireAuth,csrf,async(_req,res)=>{const auth=res.locals.auth as Authentication;await store.revokeSession(auth.session.idHash);res.set('Set-Cookie',clearSessionCookie()).status(204).end();});
 app.post('/auth/rotate',requireAuth,csrf,async(_req,res)=>{const auth=res.locals.auth as Authentication;const issued=await issueSession(store,auth.user,auth);res.set('Set-Cookie',sessionCookie(issued.rawSessionId,issued.maxAge)).json({csrfToken:issued.csrfToken,expiresAt:issued.session.expiresAt});});
 app.use('/api',requireAuth); app.use('/api',csrf);
 app.post('/api/account/sleeper',rateLimit('username',20,60_000),async(req,res,next)=>{try{const username=typeof req.body?.username==='string'?req.body.username.trim():'';const leagueIds:string[]=Array.isArray(req.body?.leagueIds)?req.body.leagueIds.filter((id:unknown):id is string=>typeof id==='string').slice(0,50):[];if(!username)return res.status(400).json({error:'A Sleeper username is required.'});const sleeperUser=await sleeper.user(username);if(!sleeperUser)return res.status(404).json({error:'Sleeper user not found.'});if(leagueIds.length){const year=new Date().getUTCFullYear();const available=(await Promise.all([year,year-1,year-2].map(season=>sleeper.leagues(sleeperUser.user_id,season)))).flat();const allowed=new Set(available.map(league=>league.league_id));if(leagueIds.some(id=>!allowed.has(id)))return res.status(403).json({error:'A selected league does not belong to the claimed Sleeper account.'});}const auth=res.locals.auth as Authentication;const updated={...auth.user,sleeperUserId:sleeperUser.user_id,sleeperUsername:sleeperUser.username,sleeperLeagueIds:[...new Set(leagueIds)]};await store.saveApplicationUser(updated);res.json({user:publicUser(updated),verification:'claimed'});}catch(error){next(error);}});

 app.param('leagueId',(req,res,next,value)=>{const user=(res.locals.auth as Authentication).user;if(value==='demo'&&process.env.ENABLE_DEMO_AUTH==='true')return next();if(!user.sleeperLeagueIds.includes(value))return res.status(403).json({error:'This league is not linked to the authenticated account.'});next();});
 app.get('/api/trades/:leagueId',rateLimit('recommendation',30,60_000), async (req, res, next) => {
   try {
     let bounds;
     try {
       const requested = Object.fromEntries(Object.entries(req.query).filter(([key]) => !['week', 'force', 'format'].includes(key)).map(([key, value]) => {
         if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid bound.');
         return [key, Number(value)];
       }));
       bounds = parseTradeBounds(requested);
     } catch { return res.status(400).json({ error: 'Invalid trade bounds. Use numeric fairness/risk fractions from 0 to 1 and documented search limits.' }); }
     if (String(req.params.leagueId) === 'demo') return res.json(recommendTrades({ ...demoTradeInput(new Date(), req.query.format === 'dynasty'), bounds }));
     const week = Number(req.query.week), userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (typeof req.query.week !== 'string' || !Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     try { await sync.syncLeague(String(req.params.leagueId), week, req.query.force === 'true'); } catch (error) {
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
 app.get('/api/lineup/:leagueId',rateLimit('recommendation',30,60_000), async (req, res, next) => {
   try {
     if (String(req.params.leagueId) === 'demo') return res.json(analyzeLineup(demoLineupInput()));
     const week = Number(req.query.week), userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (typeof req.query.week !== 'string' || !Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     try { await sync.syncLeague(String(req.params.leagueId), week, req.query.force === 'true'); } catch (error) {
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
 app.get('/api/waivers/:leagueId',rateLimit('recommendation',30,60_000), async (req, res, next) => {
   try {
     if (String(req.params.leagueId) === 'demo') return res.json(recommendWaivers(demoWaiverInput()));
     const week = Number(req.query.week);
     const userId = (res.locals.auth as Authentication).user.sleeperUserId;
     if (!Number.isInteger(week) || week < 1 || week > 18 || !userId) return res.status(400).json({ error: 'Link a Sleeper account and provide an integer week from 1 to 18.' });
     try { await sync.syncLeague(String(req.params.leagueId), week, req.query.force === 'true'); } catch (error) {
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
 app.get('/api/dashboard/:leagueId',async(req,res)=>{let data=await store.snapshot(String(req.params.leagueId)); if(!data&&String(req.params.leagueId)==='demo'){data=demoSnapshot();await store.save(data);} if(!data)return res.status(404).json({error:'League not synced'});res.json(String(req.params.leagueId) === 'demo' ? data : { ...data, scoring: (await store.league(String(req.params.leagueId)))?.scoring ?? scoringUnavailable(), recommendations: [] });});
 app.post('/api/sync/:leagueId',rateLimit('sync',10,60_000),async(req,res,next)=>{try{if(String(req.params.leagueId)==='demo'){const data=demoSnapshot();await store.save(data);return res.json(data);}const week=Math.max(1,Math.min(18,Number(req.query.week)||1));res.json(await sync.syncLeague(String(req.params.leagueId),week,req.query.force==='true'));}catch(error){next(error);}});
 app.get('/api/sleeper/users/:username',rateLimit('username',20,60_000),async(req,res,next)=>{try{const user=await sleeper.user(String(req.params.username));if(!user)return res.status(404).json({error:'No Sleeper account was found for that username.'});res.json(user);}catch(error){next(error);}});
 app.get('/api/sleeper/users/:userId/leagues',rateLimit('username',20,60_000),async(req,res,next)=>{try{const linked=(res.locals.auth as Authentication).user.sleeperUserId;if(String(req.params.userId)!==linked)return res.status(403).json({error:'Only the linked Sleeper account may be queried.'});const current=new Date().getUTCFullYear();const requested=typeof req.query.seasons==='string'?req.query.seasons.split(','):[current,current-1,current-2].map(String);const seasons=requested.filter(season=>/^\d{4}$/.test(season)).slice(0,6);if(!seasons.length)return res.status(400).json({error:'Provide at least one valid season.'});const results=await Promise.all(seasons.map(async season=>({season,leagues:await sleeper.leagues(String(req.params.userId),season)})));res.json({seasons:results,lastSyncedAt:new Date().toISOString()});}catch(error){next(error);}});
 app.get('/api/sleeper/leagues/:leagueId',async(req,res,next)=>{try{const leagueId=String(req.params.leagueId);const week=Math.max(1,Number(req.query.week)||1);const round=Math.max(1,Number(req.query.round)||week);const [league,rosters,users,matchups,transactions,drafts,tradedPicks]=await Promise.all([sync.synchronizeLeagueMetadata(leagueId),sleeper.rosters(leagueId),sleeper.leagueUsers(leagueId),sleeper.matchups(leagueId,week),sleeper.transactions(leagueId,round),sleeper.drafts(leagueId),sleeper.tradedPicks(leagueId)]);res.json({league,scoring:(await store.league(leagueId))?.scoring,rosters,users,matchups,transactions,drafts,tradedPicks,lastSyncedAt:new Date().toISOString()});}catch(error){next(error);}});
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{const status=error instanceof SleeperApiError&&error.status===404?404:502;res.status(status).json({error:status===404?'Sleeper resource not found.':'Sleeper is unavailable right now. Please try again.',category:error instanceof SleeperApiError?error.category:'internal'});});
 return app; }
