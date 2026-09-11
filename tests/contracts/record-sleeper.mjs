import { writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sanitizer } from './sanitize.mjs';
const root = new URL('../fixtures/sleeper/', import.meta.url);
const sanitize = sanitizer(); const recordedAt = new Date().toISOString(); const responses = [];
async function get(path) {
  const response = await fetch(`https://api.sleeper.app/v1${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Sleeper capture failed with HTTP ${response.status}; no raw response retained.`);
  return response.json();
}
async function save(name, endpoint, value) {
  const payload = JSON.stringify(value, null, 2) + '\n';
  responses.push({ file: `${name}.json`, endpoint, recordedAt, sha256: createHash('sha256').update(payload).digest('hex') });
  await writeFile(new URL(`${name}.json.tmp`, root), payload);
}
await mkdir(root, { recursive: true });
// Public example league from https://docs.sleeper.com/. Override only with an authorized fixture league.
// Identifying values are accepted via environment, so neither shell history nor provenance stores them.
const leagueId = process.env.SLEEPER_FIXTURE_LEAGUE_ID ?? '289646328504385536';
const week = process.env.SLEEPER_FIXTURE_WEEK ?? '1';
if (!/^\d+$/.test(leagueId) || !/^(?:[1-9]|1[0-8])$/.test(week)) throw new Error('Invalid capture league/week');
try {
  const league = await get(`/league/${leagueId}`);
  if (!league?.league_id) throw new Error('Capture league unavailable; supply SLEEPER_FIXTURE_LEAGUE_ID for an authorized public test league.');
  await save('league', '/league/{leagueId}', sanitize.league(league));
  let members;
  for (const [name, path, kind] of [['users', 'users', 'users'], ['rosters', 'rosters', 'rosters'], ['matchups', `matchups/${week}`, 'matchups'], ['transactions', `transactions/${week}`, 'transactions'], ['drafts', 'drafts', 'drafts'], ['traded-picks', 'traded_picks', 'tradedPicks']]) {
    const value = await get(`/league/${leagueId}/${path}`); if (name === 'users') members = value;
    await save(name, `/league/{leagueId}/${path.replace(/\d+$/, '{week}')}`, sanitize[kind](value));
  }
  if (members?.[0]) {
    const raw = await get(`/user/${members[0].user_id}`);
    await save('user', '/user/{userId}', sanitize.user(raw));
    await save('leagues', '/user/{userId}/leagues/nfl/{season}', sanitize.leagues(await get(`/user/${members[0].user_id}/leagues/nfl/${league.season}`)));
  }
  const players = await get('/players/nfl');
  // Preserve only a public NFL player subset; account identifiers never belong in this endpoint.
  const subset = Object.fromEntries(Object.entries(players).filter(([id]) => ['4034', '4046', 'KC'].includes(id)));
  await save('players', '/players/nfl', sanitize.players(subset));
  for (const r of responses) await rename(new URL(`${r.file}.tmp`, root), new URL(r.file, root));
  await writeFile(new URL('manifest.json', root), JSON.stringify({ source: 'https://api.sleeper.app/v1', sanitizerVersion: 1,
    captureKind: 'live-http', note: 'Account/league/draft/transaction ids remapped; names synthetic; avatars and arbitrary metadata removed. NFL player fields are public. Players are a subset.', responses }, null, 2) + '\n');
  console.log(`Recorded ${responses.length} sanitized live Sleeper contracts.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
