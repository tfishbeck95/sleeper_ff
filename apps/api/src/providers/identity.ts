import type { NflPlayer } from '@sleeper/domain';
import type { IdentityLink, ProviderIdentity, UnresolvedIdentity, UnresolvedReason } from './provider.js';

/**
 * Provider identity to Sleeper player id.
 *
 * A mismapped identity is worse than a missing one: it silently attributes one player's projection to
 * another, and every downstream number stays plausible. So this resolver only ever asserts a match it
 * can justify, and reports everything else. It never falls back to a fuzzy or best-effort match, and
 * an ambiguous name resolves to *nothing* rather than to the first candidate.
 */

/** Match strength, ordered strongest first. Recorded per player so a weak match can be audited. */
export type MatchMethod = 'cross-id' | 'team-defense' | 'name-team-position' | 'name-position';

export interface ResolvedIdentity { providerId: string; sleeperId: string; method: MatchMethod; }
export interface IdentityResolution {
  resolved: ResolvedIdentity[];
  unresolved: UnresolvedIdentity[];
  /** Coverage figures the service level is measured against. */
  stats: { total: number; resolved: number; rate: number; byMethod: Record<MatchMethod, number> };
}

/** Relocations and abbreviation drift, so a 2019 identity map still matches today's Sleeper team. */
const TEAM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  OAK: 'LV', SD: 'LAC', SDG: 'LAC', STL: 'LAR', LA: 'LAR', RAM: 'LAR', RAI: 'LV',
  WSH: 'WAS', WFT: 'WAS', JAC: 'JAX', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', LVR: 'LV', GNB: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB',
});
export const normalizeTeam = (value: string | null | undefined): string | null => {
  const upper = value?.trim().toUpperCase();
  return upper ? TEAM_ALIASES[upper] ?? upper : null;
};

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
/**
 * Names are compared on letters only. Punctuation carries no information here and is inconsistent
 * across sources ("D.J." / "DJ", "Ja'Marr" / "JaMarr"), while generational suffixes are frequently
 * present in one source and absent in the other for the same person.
 */
export function normalizeName(value: string): string {
  const cleaned = value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  while (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** Sleeper's DEF entity carries the team abbreviation as its player id, not a person's name. */
const isTeamDefense = (position: string | null | undefined) => position === 'DEF' || position === 'DST' || position === 'D/ST';
/** Flex families that legitimately differ between sources; a disagreement inside one is not a mismatch. */
const POSITION_FAMILY: Readonly<Record<string, string>> = Object.freeze({ QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K', DEF: 'DEF', DST: 'DEF', 'D/ST': 'DEF' });
const family = (position: string | null | undefined) => (position ? POSITION_FAMILY[position.toUpperCase()] ?? position.toUpperCase() : null);

type Index = Map<string, string[]>;
const push = (index: Index, key: string, value: string) => { const bucket = index.get(key); if (bucket) { if (!bucket.includes(value)) bucket.push(value); } else index.set(key, [value]); };

/**
 * Resolves a source's players against a licensed identity map, checked back against the synchronized
 * Sleeper player directory.
 *
 * The directory check is not redundant. An identity map is published on its own cadence and retains
 * ids for players Sleeper has since removed; without it, a retired player's projection would resolve
 * cleanly and then vanish at the scoring boundary as an unexplained rejection.
 */
export function resolveIdentities(identities: readonly ProviderIdentity[], links: readonly IdentityLink[], sleeperPlayers: readonly NflPlayer[]): IdentityResolution {
  const directory = new Map(sleeperPlayers.map(player => [player.id, player]));
  const defenseIds = new Set(sleeperPlayers.filter(player => isTeamDefense(player.position) || player.fantasyPositions.some(isTeamDefense)).map(player => player.id));

  const byCrossId: Index = new Map();
  const byNameTeamPosition: Index = new Map();
  const byNamePosition: Index = new Map();
  for (const link of links) {
    if (!directory.has(link.sleeperId)) continue;
    for (const [namespace, id] of Object.entries(link.crossIds)) if (id) push(byCrossId, `${namespace}:${id}`, link.sleeperId);
    const name = normalizeName(link.name); const position = family(link.position); const team = normalizeTeam(link.team);
    if (!name || !position) continue;
    push(byNamePosition, `${name}|${position}`, link.sleeperId);
    if (team) push(byNameTeamPosition, `${name}|${team}|${position}`, link.sleeperId);
  }

  const resolved: ResolvedIdentity[] = [];
  const unresolved: UnresolvedIdentity[] = [];
  const byMethod: Record<MatchMethod, number> = { 'cross-id': 0, 'team-defense': 0, 'name-team-position': 0, 'name-position': 0 };
  const fail = (identity: ProviderIdentity, reason: UnresolvedReason, message: string, candidates: string[] = []) =>
    unresolved.push({ providerId: identity.providerId, name: identity.name, team: identity.team, position: identity.position, reason, candidates, message });

  for (const identity of identities) {
    const position = family(identity.position);
    const team = normalizeTeam(identity.team);

    // A team defense is a team, so it is matched as one. Running it through the name index would
    // compare "Pittsburgh Steelers" against a person and correctly find nothing.
    if (position === 'DEF') {
      if (!team) { fail(identity, 'no-match', 'Team defense supplied without a team abbreviation.'); continue; }
      if (!defenseIds.has(team)) { fail(identity, 'not-in-sleeper', `No synchronized Sleeper team defense for ${team}.`); continue; }
      resolved.push({ providerId: identity.providerId, sleeperId: team, method: 'team-defense' }); byMethod['team-defense']++; continue;
    }

    const attempts: Array<[MatchMethod, string[]]> = [];
    for (const [namespace, id] of Object.entries(identity.crossIds)) if (id) attempts.push(['cross-id', byCrossId.get(`${namespace}:${id}`) ?? []]);
    const name = normalizeName(identity.name);
    if (name && position) {
      if (team) attempts.push(['name-team-position', byNameTeamPosition.get(`${name}|${team}|${position}`) ?? []]);
      attempts.push(['name-position', byNamePosition.get(`${name}|${position}`) ?? []]);
    }

    const matched = attempts.find(([, candidates]) => candidates.length === 1);
    if (!matched) {
      // An id or name that maps to several Sleeper players is reported with every candidate rather
      // than decided here: picking one would be a guess wearing a resolved identity's clothes.
      const ambiguous = attempts.find(([, candidates]) => candidates.length > 1);
      if (ambiguous) fail(identity, 'ambiguous', `${identity.name} matched ${ambiguous[1].length} Sleeper players by ${ambiguous[0]}; no unique identity.`, ambiguous[1]);
      else if (!name || !position) fail(identity, 'no-match', 'Provider row lacks the name or position needed to match.');
      else fail(identity, 'no-match', `${identity.name} (${position}${team ? `, ${team}` : ''}) is absent from the identity map.`);
      continue;
    }

    const [method, [sleeperId]] = matched;
    const player = directory.get(sleeperId)!;
    const sleeperFamily = family(player.position) ?? family(player.fantasyPositions[0]);
    // A cross-id can outlive a position change, and a name can collide across positions. Either way a
    // WR projection landing on a TE would misprice a lineup slot, so the disagreement is refused.
    if (position && sleeperFamily && position !== sleeperFamily && !player.fantasyPositions.map(family).includes(position)) {
      fail(identity, 'position-mismatch', `${identity.name} is ${position} at the source and ${sleeperFamily} in Sleeper (${sleeperId}).`, [sleeperId]);
      continue;
    }
    resolved.push({ providerId: identity.providerId, sleeperId, method }); byMethod[method]++;
  }

  const total = identities.length;
  return { resolved, unresolved, stats: { total, resolved: resolved.length, rate: total ? resolved.length / total : 0, byMethod } };
}
