import { demoLineupInput } from '../../apps/api/dist/lineup-demo.js';
import { EXPECTED_SCORING } from '../../packages/domain/dist/index.js';
export const year = String(new Date().getUTCFullYear());
export const USER = '910000000000000001', COOWNER = '910000000000000002';
export const LEAGUE = '920000000000000001';
export const formats = ['complete', 'standard', 'ppr', 'dynasty', 'keeper', 'superflex', 'kicker', 'defense', 'mismatch', 'unavailable'];
export function scenario(mode = 'complete') {
  if (!formats.includes(mode)) throw new Error('Unknown fixture scenario');
  const input = demoLineupInput();
  const settings = { ...input.league.settings, type: 0, leg: 8 };
  const positions = ['RB', 'WR', 'TE', 'BN', 'BN', 'BN'];
  if (mode === 'dynasty') settings.type = 2;
  if (mode === 'keeper') { settings.type = 1; settings.keeper_count = 2; }
  if (mode === 'superflex') positions.unshift('SUPER_FLEX');
  if (mode === 'kicker') positions.unshift('K');
  if (mode === 'defense') positions.unshift('DEF');
  const scoring = { ...EXPECTED_SCORING };
  if (mode === 'standard') scoring.rec = 0;
  if (mode === 'mismatch') scoring.pass_td = 99;
  const make = (id, season, name) => ({ league_id: id, name, season, status: 'in_season', season_type: 'regular', total_rosters: 2,
    previous_league_id: null, roster_positions: positions, settings, ...(mode === 'unavailable' ? {} : { scoring_settings: scoring }) });
  const leagues = [make(LEAGUE, year, 'Contract League'), make('920000000000000002', year, 'Second League'),
    make('920000000000000003', String(Number(year)-1), 'Previous Season'), make('920000000000000004', String(Number(year)-2), 'Older Season')];
  const rosters = input.rosters.map((r, i) => ({ roster_id: r.rosterId, owner_id: i === 0 ? USER : '910000000000000003',
    co_owners: i === 0 ? [COOWNER] : null, players: r.playerIds, starters: r.starterIds,
    reserve: r.reserveIds, taxi: r.taxiIds, settings: { ...r.settings, wins: 4, losses: 3, ties: 0, fpts: 800 } }));
  if (['superflex', 'kicker', 'defense'].includes(mode)) rosters[0].starters.unshift('0');
  const matchups = rosters.map(r => ({ roster_id: r.roster_id, matchup_id: 1, players: r.players, starters: r.starters, points: 21.5, custom_points: null, players_points: {} }));
  const players = Object.fromEntries(input.players.map(p => [p.id, { player_id: p.id, full_name: p.fullName, first_name: p.firstName, last_name: p.lastName,
    position: p.position, fantasy_positions: p.fantasyPositions, team: p.team, status: p.status, injury_status: p.injuryStatus }]));
  const users = [{ user_id: USER, username: 'fixture_owner', display_name: 'Fixture Owner', avatar: null },
    { user_id: COOWNER, username: 'fixture_coowner', display_name: 'Fixture Co-owner', avatar: null }];
  return { leagues, rosters, matchups, players, users, forecast: input.signals };
}
