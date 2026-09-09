import type { TradeInput } from './trades.js';
import { demoWaiverInput } from './waiver-demo.js';

/** Deliberately separate fictional scenario, evaluated by the production engine. */
export function demoTradeInput(now = new Date(), dynasty = false): TradeInput {
  const input = demoWaiverInput(now);
  input.league.name = 'Trade lab sample';
  input.league.settings = { type: dynasty ? 2 : 0, playoff_teams: 2, playoff_week_start: 17 };
  input.league.rosterPositions = ['RB', 'WR', 'BN', 'BN'].map((position, slot) => ({ position, slot }));
  const entries: Array<[string, string, string, number]> = [
    ['u-rb', 'Aaron Mills', 'RB', 8], ['u-wr', 'Jordan Cole', 'WR', 22], ['u-depth', 'Darius Bell', 'WR', 17], ['u-fallback', 'Evan Price', 'WR', 12],
    ['o-rb', 'Chris Hayes', 'RB', 22], ['o-depth', 'Miles Carter', 'RB', 17], ['o-fallback', 'Noah Walker', 'RB', 12], ['o-wr', 'Ben Ross', 'WR', 8],
  ];
  const at = { sourceUpdatedAt: null, synchronizedAt: now.toISOString() };
  input.players = entries.map(([id, fullName, position]) => ({ id, fullName, firstName: null, lastName: null, team: 'SAMPLE', position, fantasyPositions: [position], status: 'Active', ...at }));
  input.rosters.forEach((r, i) => { r.playerIds = entries.slice(i * 4, i * 4 + 4).map(e => e[0]); r.starterIds = i ? ['o-rb', 'o-wr'] : ['u-rb', 'u-wr']; r.settings = { wins: 4, losses: 3 }; });
  // Receivers earn the same weekly total through receptions, so the sample shows what full-PPR
  // scoring is worth to a trade target without changing any player's projected point total.
  const line = (position: string, points: number): Record<string, number> => position === 'WR' ? { rec: points * .4, rec_yd: points * 6 } : { rush_yd: points * 10 };
  input.signals!.players = entries.map(([playerId, , position, points]) => ({
    playerId, age: 25, expectedCareerYears: 5, uncertainty: .2, dynastyStats: { rush_yd: points * 10 },
    ...(position === 'WR' ? { recentTargets: [6, 5, 7, 6, 6, 5].map(v => Math.round(v * points / 15)) } : {}),
    weeks: Array.from({ length: 10 }, (_, i) => ({
      week: i + 8, bye: false, stats: line(position, points),
      ...(position === 'WR' ? { opportunity: { targets: Math.round(points * .4 / .65 * 10) / 10, routes: 30, routeParticipation: .85, targetShare: Math.min(.35, points / 80), redZoneTargets: .6 } } : {}),
    })),
  }));
  input.signals!.source = 'Fictional trade sample forecasts';
  input.signals!.leagues = { demo: { rookieDrafts: [{ season: String(Number(input.league.season) + 1), rounds: 3 }] } };
  return { ...input, tradedPicks: [] };
}
