import type { Matchup } from '@sleeper/domain';
import type { LineupInput } from './lineup.js';
import { demoWaiverInput } from './waiver-demo.js';

/**
 * Fictional lineup scenario evaluated by the production pipeline. It carries a partial scoring
 * reference, so the shared boundary refuses to score it and the report is explicitly unavailable —
 * exactly what a connected league without validated live scoring receives.
 */
export function demoLineupInput(now = new Date()): LineupInput {
  const input = demoWaiverInput(now);
  const at = { sourceUpdatedAt: null, synchronizedAt: now.toISOString() };
  const matchups: Matchup[] = input.rosters.slice(0, 2).map(roster => ({
    id: `demo:${input.league.season}:${input.week}:${roster.rosterId}`, leagueId: 'demo', season: input.league.season, week: input.week,
    matchupId: 1, rosterId: roster.rosterId, points: 0, customPoints: null,
    playerIds: roster.playerIds, starterIds: roster.starterIds, playerPoints: {}, ...at,
  }));
  return { ...input, matchups, users: [] };
}
