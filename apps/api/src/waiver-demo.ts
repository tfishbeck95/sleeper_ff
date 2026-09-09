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
  // `stash` is the sample pass-catching back: the same weekly total, a fifth of it from receptions.
  const line = (id: string, position: string, weekly: number) => id === 'stash'
    ? { rush_yd: weekly * 4, rec: weekly * .4, rec_yd: weekly * 2 }
    : { rush_yd: position === 'RB' ? weekly * 10 : 0, rec: position === 'RB' ? 0 : weekly / 2, rec_yd: position === 'RB' ? 0 : weekly * 5 };
  // Opportunity is workload, never points: it explains and bounds the projection above, never adds to it.
  const opportunity = (id: string, position: string, weekly: number) => position === 'RB' && id !== 'stash' ? undefined : {
    targets: Math.round((id === 'stash' ? weekly * .4 : weekly / 2) / .65 * 10) / 10,
    routes: id === 'stash' ? 22 : 32,
    routeParticipation: id === 'stash' ? .62 : .88,
    targetShare: id === 'stash' ? .14 : Math.min(.35, weekly / 60),
    redZoneTargets: id === 'add-wr' ? 1.8 : .4,
  };
  // Observed target series, scaled to each player's own projected volume so the sample stays coherent.
  const series = (shape: number[], id: string, position: string, weekly: number) => shape.map(factor => Math.round(factor * (opportunity(id, position, weekly)?.targets ?? 0)));
  const steady = [1, .9, 1.1, 1, 1, .9], climbing = [.3, .5, .7, 1.2, 1.4, 1.5], erratic = [.15, 1.8, .3, 1.7, .4, 1.6];
  const signals: PlayerSignal[] = entries.map(([playerId, , position, weekly, future]) => ({ playerId,
    weeks: Array.from({ length: 10 }, (_, i) => ({ week: i + 8, stats: line(playerId, position, weekly), floorStats: line(playerId, position, weekly * .7), ceilingStats: line(playerId, position, weekly * 1.35), opponent: ['SAMPLE A', 'SAMPLE B', 'SAMPLE C'][i % 3], bye: playerId === 'starter-te' && i === 0, matchupMultiplier: i > 7 ? 1.1 : 1, opportunity: opportunity(playerId, position, weekly) })),
    dynastyStats: { rush_yd: future * 10 }, role: { previousShare: .4, recentShare: playerId === 'add-rb' ? .65 : .4, games: 4 },
    recentTargets: position === 'RB' && playerId !== 'stash' ? undefined : series(playerId === 'add-wr' ? climbing : playerId === 'add-te' ? erratic : steady, playerId, position, weekly),
  }));
  return { league, rosters, players, rosterId: 1, week: 8, now, signals: { source: 'Fictional sample forecasts', season: league.season, week: 8, updatedAt: now.toISOString(), players: signals } };
}
