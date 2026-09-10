import assert from 'node:assert/strict';
import test from 'node:test';
import type { NflPlayer } from '@sleeper/domain';
import { normalizeName, normalizeTeam, resolveIdentities } from './identity.js';
import type { IdentityLink, ProviderIdentity } from './provider.js';

const player = (id: string, fullName: string, position: string, team: string | null = 'KC', fantasy = [position]): NflPlayer => ({
  id, firstName: fullName.split(' ')[0], lastName: fullName.split(' ').slice(1).join(' '), fullName,
  team, position, fantasyPositions: fantasy, status: 'Active', sourceUpdatedAt: null, synchronizedAt: '2026-09-10T00:00:00.000Z',
});
const link = (sleeperId: string, name: string, position: string, team: string | null, crossIds: Record<string, string> = {}): IdentityLink => ({ sleeperId, name, position, team, crossIds });
const identity = (providerId: string, name: string, position: string | null, team: string | null, crossIds: Record<string, string> = {}): ProviderIdentity => ({ providerId, name, position, team, crossIds });

test('a cross-reference id resolves without consulting the name at all', () => {
  const result = resolveIdentities(
    [identity('sd-1', 'Completely Different Spelling', 'WR', 'KC', { gsis: '00-0033040' })],
    [link('4034', 'Tyreek Hill', 'WR', 'KC', { gsis: '00-0033040' })],
    [player('4034', 'Tyreek Hill', 'WR')],
  );
  assert.deepEqual(result.resolved, [{ providerId: 'sd-1', sleeperId: '4034', method: 'cross-id' }]);
  assert.equal(result.stats.rate, 1);
});

test('punctuation, accents and generational suffixes do not prevent a name match', () => {
  assert.equal(normalizeName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(normalizeName('D.J. Moore'), 'dj moore');
  assert.equal(normalizeName('Michael Pittman Jr.'), 'michael pittman');
  assert.equal(normalizeName('José Álvarez'), 'jose alvarez');
  const result = resolveIdentities(
    [identity('sd-2', 'Michael Pittman Jr.', 'WR', 'IND')],
    [link('6801', 'Michael Pittman', 'WR', 'IND')],
    [player('6801', 'Michael Pittman', 'WR', 'IND')],
  );
  assert.equal(result.resolved[0]?.sleeperId, '6801');
  assert.equal(result.resolved[0]?.method, 'name-team-position');
});

test('relocated team abbreviations still match', () => {
  assert.equal(normalizeTeam('OAK'), 'LV');
  assert.equal(normalizeTeam('SD'), 'LAC');
  assert.equal(normalizeTeam('jax'), 'JAX');
  assert.equal(normalizeTeam(null), null);
});

test('a team defense resolves by team abbreviation, which is Sleeper\'s DEF player id', () => {
  const result = resolveIdentities(
    [identity('DEF:PIT', 'Pittsburgh Steelers defense', 'DEF', 'PIT')],
    [],
    [player('PIT', 'Pittsburgh Steelers', 'DEF', 'PIT')],
  );
  assert.deepEqual(result.resolved, [{ providerId: 'DEF:PIT', sleeperId: 'PIT', method: 'team-defense' }]);
});

test('an ambiguous name resolves to nothing and reports every candidate', () => {
  const result = resolveIdentities(
    [identity('sd-3', 'Mike Williams', 'WR', null)],
    [link('a', 'Mike Williams', 'WR', 'LAC'), link('b', 'Mike Williams', 'WR', 'NYJ')],
    [player('a', 'Mike Williams', 'WR', 'LAC'), player('b', 'Mike Williams', 'WR', 'NYJ')],
  );
  assert.equal(result.resolved.length, 0);
  assert.equal(result.unresolved[0].reason, 'ambiguous');
  assert.deepEqual(result.unresolved[0].candidates.sort(), ['a', 'b']);
});

test('a position disagreement is refused rather than mapped', () => {
  const result = resolveIdentities(
    [identity('sd-4', 'Taysom Hill', 'WR', 'NO', { gsis: '00-0033357' })],
    [link('3678', 'Taysom Hill', 'TE', 'NO', { gsis: '00-0033357' })],
    [player('3678', 'Taysom Hill', 'TE', 'NO', ['TE'])],
  );
  assert.equal(result.resolved.length, 0);
  assert.equal(result.unresolved[0].reason, 'position-mismatch');
});

test('a multi-position Sleeper player accepts either of its fantasy positions', () => {
  const result = resolveIdentities(
    [identity('sd-5', 'Cordarrelle Patterson', 'RB', 'ATL', { gsis: '00-0030496' })],
    [link('1234', 'Cordarrelle Patterson', 'WR', 'ATL', { gsis: '00-0030496' })],
    [player('1234', 'Cordarrelle Patterson', 'WR', 'ATL', ['WR', 'RB'])],
  );
  assert.equal(result.resolved[0]?.sleeperId, '1234');
});

test('an identity map row for a player Sleeper no longer carries never resolves', () => {
  const result = resolveIdentities(
    [identity('sd-6', 'Retired Player', 'RB', 'KC', { gsis: 'gone' })],
    [link('9999', 'Retired Player', 'RB', 'KC', { gsis: 'gone' })],
    [player('4034', 'Tyreek Hill', 'WR')],
  );
  assert.equal(result.resolved.length, 0);
  assert.equal(result.unresolved[0].reason, 'no-match');
  assert.match(result.unresolved[0].message, /absent from the identity map/);
});

test('the match rate and per-method counts are reported for the service level', () => {
  const result = resolveIdentities(
    [
      identity('a', 'Tyreek Hill', 'WR', 'MIA', { gsis: 'g1' }),
      identity('b', 'Unknown Person', 'WR', 'MIA'),
    ],
    [link('1', 'Tyreek Hill', 'WR', 'MIA', { gsis: 'g1' })],
    [player('1', 'Tyreek Hill', 'WR', 'MIA')],
  );
  assert.equal(result.stats.total, 2);
  assert.equal(result.stats.resolved, 1);
  assert.equal(result.stats.rate, 0.5);
  assert.equal(result.stats.byMethod['cross-id'], 1);
});
