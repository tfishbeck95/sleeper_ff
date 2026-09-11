import { createServer } from 'node:http';
import { scenario } from './scenarios.mjs';
// In-process controls are available only to the test runner. There is no reset/admin HTTP endpoint
// in the application or fixture service, and no fallback to Sleeper when a route is unrecognized.
export async function sleeperServer() {
  let data = scenario(); const faults = new Map(); const counts = new Map(); const gates = new Map();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (gates.has(path)) await gates.get(path).promise;
    if (res.destroyed) return;
    const sequence = faults.get(path); const fault = sequence?.length > 1 ? sequence.shift() : sequence?.[0];
    const send = (code, value, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (fault === 'timeout') return; // Client's real AbortSignal must terminate this socket.
    if (typeof fault === 'number') return send(fault, { error: 'fixture failure' }, fault === 429 ? { 'retry-after': '30' } : {});
    if (path === '/v1/players/nfl') return send(200, data.players);
    let match = path.match(/^\/v1\/user\/([^/]+)$/);
    if (match) return send(200, data.users.find(u => u.username === decodeURIComponent(match[1]) || u.user_id === match[1]) ?? null);
    match = path.match(/^\/v1\/user\/([^/]+)\/leagues\/nfl\/(\d{4})$/);
    if (match) return send(200, data.users.some(u => u.user_id === match[1]) ? data.leagues.filter(l => l.season === match[2]) : []);
    match = path.match(/^\/v1\/league\/(\d+)(?:\/(.*))?$/);
    if (match) {
      const league = data.leagues.find(l => l.league_id === match[1]);
      if (!league) return send(404, null);
      const resource = match[2];
      if (!resource) return send(200, league);
      if (resource === 'rosters') return send(200, data.rosters);
      if (resource === 'users') return send(200, data.users);
      if (resource.startsWith('matchups/')) return send(200, data.matchups);
      if (resource.startsWith('transactions/') || resource === 'drafts' || resource === 'traded_picks') return send(200, []);
    }
    send(404, { error: 'Unconfigured fixture route' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, counts,
    set(mode) { data = scenario(mode); faults.clear(); counts.clear(); },
    fault(path, sequence) { faults.set(path, [...sequence]); counts.delete(path); },
    clearFaults() { faults.clear(); },
    hold(path) { let release; const promise = new Promise(r => { release = r; }); gates.set(path, { promise, release }); return () => { gates.delete(path); release(); }; },
    async close() { for (const gate of gates.values()) gate.release(); server.closeAllConnections(); await new Promise(r => server.close(r)); },
  };
}
