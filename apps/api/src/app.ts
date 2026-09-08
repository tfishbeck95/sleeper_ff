import express from 'express'; import cors from 'cors'; import { demoSnapshot } from './demo.js'; import type { JsonStore } from './store.js';
export function createApp(store: JsonStore) { const app=express(); app.use(cors({origin:process.env.WEB_ORIGIN ?? 'http://localhost:5173'})); app.use(express.json());
 app.get('/health',(_req,res)=>res.json({status:'ok'}));
 app.use('/api',(req,res,next)=>{const auth=req.header('authorization'); if(auth!==`Bearer ${process.env.DEMO_TOKEN ?? 'demo-token'}`) return res.status(401).json({error:'Unauthorized'}); next();});
 app.get('/api/dashboard/:leagueId',async(req,res)=>{let data=await store.snapshot(req.params.leagueId); if(!data&&req.params.leagueId==='demo'){data=demoSnapshot();await store.save(data);} if(!data)return res.status(404).json({error:'League not synced'});res.json(data);});
 app.post('/api/sync/:leagueId',async(req,res)=>{if(req.params.leagueId!=='demo')return res.status(202).json({status:'queued',message:'League sync queued'});const data=demoSnapshot();await store.save(data);res.json(data);});
 return app; }
