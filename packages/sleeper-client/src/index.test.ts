import assert from 'node:assert/strict';
import test from 'node:test';
import { SleeperClient, SleeperClientError } from './index.js';
test('retries retryable responses with a bound', async () => { let calls=0; const fetcher=async()=>{calls++;return calls<3?new Response('',{status:503}):Response.json({league_id:'1'})}; const client=new SleeperClient(fetcher as typeof fetch,{maxRetries:2,baseDelayMs:1}); assert.equal((await client.league('1')).league_id,'1'); assert.equal(calls,3); });
test('categorizes invalid responses', async () => { const client=new SleeperClient((async()=>Response.json({wrong:true})) as typeof fetch,{maxRetries:0}); await assert.rejects(client.league('1'), (error: unknown) => error instanceof SleeperClientError && error.kind === 'invalid_response'); });
