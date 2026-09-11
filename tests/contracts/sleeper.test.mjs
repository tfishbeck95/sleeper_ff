import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SleeperClient } from '../../packages/sleeper-client/dist/index.js';
import { normalizePlayers } from '../../apps/api/dist/players.js';
import { sanitizer } from './sanitize.mjs';
const root = new URL('../fixtures/sleeper/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const fixtures = {};
for (const item of manifest.responses) {
  const bytes = await readFile(new URL(item.file, root), 'utf8');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, `Unexpected fixture edit: ${item.file}`);
  fixtures[item.file.replace('.json','')] = JSON.parse(bytes);
}
test('recorded live contracts pass the real Sleeper client boundary', async () => {
  const payloads = ['user','leagues','league','rosters','users','matchups','transactions','drafts','traded-picks','players'];
  const client = new SleeperClient(async () => new Response(JSON.stringify(fixtures[payloads.shift()]), { status: 200 }), 'http://fixture', { maxRetries: 0 });
  assert.ok(await client.user('fixture')); assert.ok((await client.leagues('fixture','2018')).length);
  assert.ok((await client.league('fixture')).league_id); assert.ok((await client.rosters('fixture')).length);
  assert.ok((await client.leagueUsers('fixture')).length); assert.ok((await client.matchups('fixture',1)).length);
  assert.ok(Array.isArray(await client.transactions('fixture',1))); assert.ok(Array.isArray(await client.drafts('fixture')));
  assert.ok(Array.isArray(await client.tradedPicks('fixture')));
  assert.equal(normalizePlayers(await client.players(), new Date().toISOString()).length, Object.keys(fixtures.players).length);
  assert.equal(payloads.length, 0);
});
test('sanitization removes arbitrary identifying fields and preserves owner/co-owner joins', () => {
  const s = sanitizer();
  const raw = { user_id: 'original-user-8675309', username: 'PrivateName', display_name: 'Private Full Name', avatar: 'private-avatar', email: 'secret@example.invalid', metadata: { private: 'PrivateName' }, phone: '555-1234' };
  const user = s.user(raw);
  const roster = s.rosters([{ roster_id: 1, owner_id: raw.user_id, co_owners: ['private-coowner'], players: ['4034'], starters: ['4034'], settings: { wins: 1, custom: 'PrivateName' }, metadata: raw.metadata }])[0];
  const co = s.user({ ...raw, user_id: 'private-coowner' });
  assert.equal(user.user_id, roster.owner_id); assert.equal(co.user_id, roster.co_owners[0]);
  assert.doesNotMatch(JSON.stringify({ user, roster, co }), /original|Private|private-|secret@|555-1234/);
  assert.deepEqual(roster.players, ['4034']); assert.deepEqual(roster.settings, { wins: 1 });
});
test('committed contracts contain only sanitized account names and identifiers', () => {
  assert.equal(manifest.captureKind, 'live-http');
  for (const u of [...fixtures.users, fixtures.user]) { assert.match(u.user_id, /^91\d{16}$/); assert.match(u.username, /^fixture_user_\d{3}$/); assert.equal(u.avatar, null); assert.equal(u.metadata, undefined); }
  for (const l of [fixtures.league, ...fixtures.leagues]) { assert.match(l.league_id, /^92\d{16}$/); assert.match(l.name, /^Fixture League /); }
  for (const r of fixtures.rosters) { if (r.owner_id) assert.match(r.owner_id, /^91\d{16}$/); for (const id of r.co_owners ?? []) assert.match(id, /^91\d{16}$/); assert.equal(r.metadata, undefined); }
});
