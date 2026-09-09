import { referenceScoring } from '@sleeper/domain';
import type { League, NflPlayer, Roster } from '@sleeper/domain';
import type { WaiverInput } from './waivers.js';
import type { PlayerSignal } from './waiver-signals.js';

/** Fictional fixture uses the same pipeline as connected leagues. Never merged into live data. */
export function demoWaiverInput(now = new Date()): WaiverInput {
  const at = { sourceUpdatedAt: null, synchronizedAt: now.toISOString() };
  const league: League = { id: 'demo', scoring: referenceScoring(), name: 'Sunday Legends', season: String(now.getUTCFullYear()), status: 'in_season', previousLeagueId: null, totalRosters: 2, scoringSettings: [{ key: 'rec', points: 1 }, { key: 'rec_yd', points: .1 }, { key: 'rush_yd', points: .1 }], rosterPositions: ['RB', 'WR', 'TE', 'BN', 'BN', 'BN'].map((position, slot) => ({ position, slot })), settings: { type: 2, waiver_type: 2, waiver_budget: 100, playoff_teams: 2, playoff_week_start: 17 }, ...at };
  const entries: Array<[string, string, string, number, number]> = [
    ['starter-rb', 'Aaron Mills', 'RB', 10, 12], ['starter-wr', 'Jordan Cole', 'WR', 12, 12], ['starter-te', 'Sam Ellis', 'TE', 8, 8],
    ['bench-1', 'Evan Price', 'RB', 3, 4], ['bench-2', 'Ben Ross', 'WR', 4, 5], ['bench-3', 'Owen Scott', 'TE', 4, 5],
    ['add-rb', 'Chris Hayes', 'RB', 13, 14], ['add-wr', 'Darius Bell', 'WR', 14, 14], ['add-te', 'Noah Walker', 'TE', 11, 7], ['stash', 'Miles Carter', 'RB', 5, 18],
  ];
  const players: NflPlayer[] = entries.map(([id, fullName, position]) => ({ id, fullName, firstName: null, lastName: null, team: 'SAMPLE', position, fantasyPositions: [position], status: 'Active', injuryStatus: id === 'starter-rb' ? 'Out' : null, ...at }));
  const rosters: Roster[] = [{ id: 'demo:1', leagueId: 'demo', rosterId: 1, ownerId: 'sample', coOwnerIds: [], playerIds: entries.slice(0, 6).map(e => e[0]), starterIds: entries.slice(0, 3).map(e => e[0]), reserveIds: [], taxiIds: [], settings: { waiver_budget_used: 35 }, ...at }, { id: 'demo:2', leagueId: 'demo', rosterId: 2, ownerId: 'other', coOwnerIds: [], playerIds: [], starterIds: [], reserveIds: [], taxiIds: [], settings: {}, ...at }];
  // Raw statistics only. Mean, floor and ceiling are three stat lines; the league scores all three.
  const line = (position: string, weekly: number) => ({ rush_yd: position === 'RB' ? weekly * 10 : 0, rec: position === 'RB' ? 0 : weekly / 2, rec_yd: position === 'RB' ? 0 : weekly * 5 });
  const signals: PlayerSignal[] = entries.map(([playerId, , position, weekly, future]) => ({ playerId,
    weeks: Array.from({ length: 10 }, (_, i) => ({ week: i + 8, stats: line(position, weekly), floorStats: line(position, weekly * .7), ceilingStats: line(position, weekly * 1.35), opponent: ['SAMPLE A', 'SAMPLE B', 'SAMPLE C'][i % 3], bye: playerId === 'starter-te' && i === 0, matchupMultiplier: i > 7 ? 1.1 : 1 })),
    dynastyStats: { rush_yd: future * 10 }, role: { previousShare: .4, recentShare: playerId === 'add-rb' ? .65 : .4, games: 4 },
  }));
  return { league, rosters, players, rosterId: 1, week: 8, now, signals: { source: 'Fictional sample forecasts', season: league.season, week: 8, updatedAt: now.toISOString(), players: signals } };
}
