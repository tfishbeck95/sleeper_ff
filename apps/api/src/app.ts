import express from 'express'; import cors from 'cors'; import { SleeperApiError, SleeperClient } from '@sleeper/sleeper-client'; import { demoSnapshot } from './demo.js'; import type { JsonStore } from './store.js';
import { LeagueSyncService } from './sync.js';
import { FileWaiverSignalProvider, type WaiverSignalProvider } from './waiver-signals.js';
import { recommendWaivers } from './waivers.js';
import { demoWaiverInput } from './waiver-demo.js';
import { parseTradeBounds, recommendTrades } from './trades.js';
import { demoTradeInput } from './trade-demo.js';
export function createApp(store: JsonStore, sleeper = new SleeperClient(), sync = new LeagueSyncService(store, sleeper), signals: WaiverSignalProvider = new FileWaiverSignalProvider()) { const app=express(); app.use(cors({origin:process.env.WEB_ORIGIN ?? 'http://localhost:5173'})); app.use(express.json());
 app.get('/health',(_req,res)=>res.json({status:'ok'}));
 app.use('/api',(req,res,next)=>{const auth=req.header('authorization'); if(auth!==`Bearer ${process.env.DEMO_TOKEN ?? 'demo-token'}`) return res.status(401).json({error:'Unauthorized'}); next();});
 app.get('/api/trades/:leagueId', async (req, res, next) => {
   try {
     let bounds;
     try {
       const requested = Object.fromEntries(Object.entries(req.query).filter(([key]) => !['week', 'userId', 'force', 'format'].includes(key)).map(([key, value]) => {
         if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid bound.');
         return [key, Number(value)];
       }));
       bounds = parseTradeBounds(requested);
     } catch { return res.status(400).json({ error: 'Invalid trade bounds. Use numeric fairness/risk fractions from 0 to 1 and documented search limits.' }); }
     if (req.params.leagueId === 'demo') return res.json(recommendTrades({ ...demoTradeInput(new Date(), req.query.format === 'dynasty'), bounds }));
     const week = Number(req.query.week), userId = req.query.userId;
     if (typeof req.query.week !== 'string' || !Number.isInteger(week) || week < 1 || week > 18 || typeof userId !== 'string' || !userId.trim()) return res.status(400).json({ error: 'Provide userId and an integer week from 1 to 18.' });
     await sync.syncLeague(req.params.leagueId, week, req.query.force === 'true');
     const context = await store.tradeContext(req.params.leagueId);
     if (!context.league) return res.status(404).json({ error: 'League not synced.' });
     const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
     if (!roster) return res.status(403).json({ error: 'This account does not own or co-own a roster in the selected league.' });
     let forecast = null;
     try { forecast = await signals.load(context.league.season, week); } catch { /* Report unavailable without leaking provider paths. */ }
     return res.json(recommendTrades({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast, bounds }));
   } catch (error) { next(error); }
 });
 app.get('/api/waivers/:leagueId', async (req, res, next) => {
   try {
     if (req.params.leagueId === 'demo') return res.json(recommendWaivers(demoWaiverInput()));
     const week = Number(req.query.week);
     const userId = req.query.userId;
     if (!Number.isInteger(week) || week < 1 || week > 18 || typeof userId !== 'string' || !userId.trim()) return res.status(400).json({ error: 'Provide userId and an integer week from 1 to 18.' });
     await sync.syncLeague(req.params.leagueId, week, req.query.force === 'true');
     const context = await store.waiverContext(req.params.leagueId);
     if (!context.league) return res.status(404).json({ error: 'League not synced.' });
     const roster = context.rosters.find(r => r.ownerId === userId || r.coOwnerIds.includes(userId));
     if (!roster) return res.status(403).json({ error: 'This account does not own or co-own a roster in the selected league.' });
     let forecast = null;
     let sourceError = false;
     try { forecast = await signals.load(context.league.season, week); } catch { sourceError = true; }
     const report = recommendWaivers({ ...context, league: context.league, rosterId: roster.rosterId, week, signals: forecast });
     if (sourceError) report.warnings = ['The forecast source could not be loaded or failed validation. Rankings are unavailable until the source is repaired.'];
     return res.json(report);
   } catch (error) { next(error); }
 });
 app.get('/api/dashboard/:leagueId',async(req,res)=>{let data=await store.snapshot(req.params.leagueId); if(!data&&req.params.leagueId==='demo'){data=demoSnapshot();await store.save(data);} if(!data)return res.status(404).json({error:'League not synced'});res.json(data);});
 app.post('/api/sync/:leagueId',async(req,res,next)=>{try{if(req.params.leagueId==='demo'){const data=demoSnapshot();await store.save(data);return res.json(data);}const week=Math.max(1,Math.min(18,Number(req.query.week)||1));res.json(await sync.syncLeague(req.params.leagueId,week,req.query.force==='true'));}catch(error){next(error);}});
 app.get('/api/sleeper/users/:username',async(req,res,next)=>{try{const user=await sleeper.user(req.params.username);if(!user)return res.status(404).json({error:'No Sleeper account was found for that username.'});res.json(user);}catch(error){next(error);}});
 app.get('/api/sleeper/users/:userId/leagues',async(req,res,next)=>{try{const current=new Date().getUTCFullYear();const requested=typeof req.query.seasons==='string'?req.query.seasons.split(','):[current,current-1,current-2].map(String);const seasons=requested.filter(season=>/^\d{4}$/.test(season)).slice(0,6);if(!seasons.length)return res.status(400).json({error:'Provide at least one valid season.'});const results=await Promise.all(seasons.map(async season=>({season,leagues:await sleeper.leagues(req.params.userId,season)})));res.json({seasons:results,lastSyncedAt:new Date().toISOString()});}catch(error){next(error);}});
 app.get('/api/sleeper/leagues/:leagueId',async(req,res,next)=>{try{const leagueId=req.params.leagueId;const week=Math.max(1,Number(req.query.week)||1);const round=Math.max(1,Number(req.query.round)||week);const [league,rosters,users,matchups,transactions,drafts,tradedPicks]=await Promise.all([sleeper.league(leagueId),sleeper.rosters(leagueId),sleeper.leagueUsers(leagueId),sleeper.matchups(leagueId,week),sleeper.transactions(leagueId,round),sleeper.drafts(leagueId),sleeper.tradedPicks(leagueId)]);res.json({league,rosters,users,matchups,transactions,drafts,tradedPicks,lastSyncedAt:new Date().toISOString()});}catch(error){next(error);}});
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{const status=error instanceof SleeperApiError&&error.status===404?404:502;res.status(status).json({error:status===404?'Sleeper resource not found.':'Sleeper is unavailable right now. Please try again.',category:error instanceof SleeperApiError?error.category:'internal'});});
 return app; }
