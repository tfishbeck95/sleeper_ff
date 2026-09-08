import { resolve } from 'node:path'; import { createApp } from './app.js'; import { JsonStore } from './store.js'; import { demoSnapshot } from './demo.js';
import { LeagueSyncService } from './sync.js';
const store=new JsonStore(resolve(process.env.DATA_FILE ?? '../../data/store.json')); const port=Number(process.env.PORT ?? 4000); const interval=Number(process.env.SYNC_INTERVAL_MINUTES ?? 30)*60_000;
async function synchronize(){await store.save(demoSnapshot());console.info('[sync] demo league refreshed');}
await synchronize(); setInterval(()=>void synchronize(),interval).unref(); createApp(store,new LeagueSyncService(store)).listen(port,()=>console.info(`API listening on http://localhost:${port}`));
