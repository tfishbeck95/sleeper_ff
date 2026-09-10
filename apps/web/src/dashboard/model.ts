import { scoringUnavailable } from '@sleeper/domain';
import type { LeagueSnapshot } from '@sleeper/domain';
import type { DashboardAlert, DashboardData, LeagueDetails, ProposedAction, WaiverTarget } from './types';

// Construct links from validated IDs, never from recommendation text or upstream URLs.
export function sleeperLeagueUrl(id: string) { return /^\d{1,30}$/.test(id) ? `https://sleeper.com/leagues/${id}` : null; }
export const checklistFor = (kind: ProposedAction['kind']): string[] => kind === 'waiver' ? [
  'Check that the target is available and eligible for your roster.',
  'Compare the target with your weakest droppable player, including future weeks.',
  'Check your waiver budget, claim priority, and the processing deadline.',
  'Review the exact add, drop, and bid in Sleeper before confirming.',
] : kind === 'trade' ? [
  'Compare both rosters and confirm this trade addresses each team’s needs.',
  'Check player health, bye weeks, and keeper or dynasty value.',
  'Review every player and pick, the trade deadline, and league rules.',
  'Decide whether to create and send the offer in Sleeper.',
] : kind === 'sync' ? [
  'Check your internet connection and selected league.',
  'Retry the sync and check the last successful sync time.',
  'Verify the current lineup and player status in Sleeper before acting.',
] : [
  'Check the latest player status and game start times.',
  'Confirm the replacement is on your roster and eligible for this slot.',
  'Check that both players are unlocked and review the rest of your lineup.',
  'Review and confirm the lineup change in Sleeper.',
];
export function syncAlert(detail: string): DashboardAlert {
  return { id: 'sync', kind: 'sync', title: 'Your league needs a refresh', detail,
    action: { id: 'sync', kind: 'sync', title: 'Review the sync issue', reason: detail, checklist: checklistFor('sync') } };
}
export function sortAlerts(alerts: DashboardAlert[]) {
  const order = { inactive: 0, bye: 1, injury: 2, empty: 3, sync: 4 };
  return [...alerts].sort((a, b) => order[a.kind] - order[b.kind]);
}
export function rankWaivers(targets: WaiverTarget[]) {
  return [...targets].sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || (b.advantage ?? -Infinity) - (a.advantage ?? -Infinity));
}
export function fromLeagueDetails(details: LeagueDetails, userId: string, week: number, snapshot: LeagueSnapshot | null, selectedRosterId?: number): DashboardData {
  const { league, rosters, users, matchups, transactions } = details;
  const roster = rosters.find(r => selectedRosterId !== undefined ? r.roster_id === selectedRosterId : r.owner_id === userId || r.co_owners?.includes(userId));
  if (!roster) throw new Error('This account no longer owns or co-owns a roster in the selected league.');
  const teamName = (id: number) => {
    const team = rosters.find(r => r.roster_id === id);
    const user = users.find(u => u.user_id === team?.owner_id);
    return team?.metadata?.team_name || user?.metadata?.team_name || user?.display_name || `Team ${id}`;
  };
  const playerName = (id: string) => details.players?.[id]?.full_name || [details.players?.[id]?.first_name, details.players?.[id]?.last_name].filter(Boolean).join(' ') || `Player ${id}`;
  const current = matchups.find(m => m.roster_id === roster.roster_id);
  const opponent = current?.matchup_id != null ? matchups.find(m => m.matchup_id === current.matchup_id && m.roster_id !== roster.roster_id) : undefined;
  const slots = league.roster_positions.filter(p => !['BN', 'IR', 'TAXI'].includes(p));
  const alerts: DashboardAlert[] = [];
  // Use the selected week's lineup when present; never substitute current starters for a historical matchup.
  const starters = current?.starters ?? roster.starters ?? [];
  const addAlert = (id: string, kind: DashboardAlert['kind'], title: string, detail: string) => alerts.push({ id, kind, title, detail, action: { id, kind: 'start', title, reason: detail, checklist: checklistFor('start') } });
  slots.forEach((slot, index) => {
    const id = starters[index];
    if (!id || id === '0') { addAlert(`empty-${index}`, 'empty', `${slot} slot is empty`, 'Review eligible bench players before this slot locks.'); return; }
    const player = details.players?.[id];
    const name = playerName(id);
    if (player?.bye_week === week) addAlert(`bye-${index}`, 'bye', `${name} has a bye`, `Your ${slot} starter has no game in Week ${week}. Review a replacement.`);
    const status = (player?.injury_status || player?.status || '').toLowerCase();
    if (['out', 'inactive', 'ir', 'injured reserve', 'suspended', 'pup', 'retired', 'deceased'].includes(status)) addAlert(`inactive-${index}`, 'inactive', `${name} is ${status}`, `Current availability flag for your ${slot} starter. Verify the selected week and latest report in Sleeper.`);
    else if (status && !['active', 'healthy'].includes(status)) addAlert(`injury-${index}`, 'injury', `${name}: ${status}`, `Your ${slot} starter needs a status check. Have an eligible backup ready.`);
  });
  if (details.playerError) alerts.push(syncAlert(details.playerError));
  const standings = rosters.map(r => ({ id: String(r.roster_id), name: teamName(r.roster_id), wins: r.settings.wins ?? 0, losses: r.settings.losses ?? 0, ties: r.settings.ties ?? 0, points: (r.settings.fpts ?? 0) + (r.settings.fpts_decimal ?? 0) / 100, isUser: r.roster_id === roster.roster_id }))
    .sort((a, b) => ((b.wins + b.ties / 2) / Math.max(1, b.wins + b.losses + b.ties)) - ((a.wins + a.ties / 2) / Math.max(1, a.wins + a.losses + a.ties)) || b.points - a.points);
  // The legacy dashboard snapshot isn't owner-scoped, so it cannot safely supply personal recommendations.
  void snapshot;
  const scoring = details.scoring ?? scoringUnavailable();
  const ppr = scoring.settings?.rec;
  const format = `${league.total_rosters ?? rosters.length} teams · ${ppr === 1 ? 'PPR' : ppr === .5 ? 'Half PPR' : ppr === 0 ? 'Non-PPR' : scoring.kind === 'unavailable' ? 'Scoring unavailable' : 'Custom scoring'} · ${league.settings.type === 2 ? 'Dynasty' : league.settings.type === 1 ? 'Keeper' : 'Redraft'}`;
  const rank = standings.findIndex(t => t.isUser) + 1;
  const spots = league.settings.playoff_teams;
  return {
    scoring, demo: false, week, teamName: teamName(roster.roster_id), format, lastSyncedAt: details.lastSyncedAt,
    coverageNote: `${details.playerMetadata?.synchronizedAt ? `Player metadata updated ${details.playerMetadata.synchronizedAt}${details.playerMetadata.stale ? ' (stale)' : ''}. ` : ''}Huddle refreshes availability at most once every 24 hours and retains older data during upstream failures; it is not a historical injury report. Bye-week schedule and projection coverage are unavailable. Recheck every starter in Sleeper.`,
    alerts: sortAlerts(alerts), starts: [], waivers: [], trades: [], needs: [], standings,
    matchup: opponent ? { opponent: teamName(opponent.roster_id), actualFor: current?.custom_points ?? current?.points, actualAgainst: opponent.custom_points ?? opponent.points, paths: ['Resolve empty or unavailable starter slots to avoid preventable missing points.'], risks: ['Player availability can change before kickoff. Projections are unavailable, so a winning margin and specific matchup risks cannot be estimated.'] } : null,
    activity: [...transactions].sort((a, b) => (b.status_updated ?? b.created ?? 0) - (a.status_updated ?? a.created ?? 0)).map(t => ({ id: t.transaction_id, type: t.type, title: `${t.roster_ids.map(teamName).join(' & ') || 'League'} · ${t.type.replace('_', ' ')}`, detail: `${t.status}. ${Object.keys(t.adds ?? {}).length ? `Added ${Object.keys(t.adds ?? {}).map(playerName).join(', ')}. ` : ''}${Object.keys(t.drops ?? {}).length ? `Dropped ${Object.keys(t.drops ?? {}).map(playerName).join(', ')}. ` : ''}${t.draft_picks?.length ? `${t.draft_picks.length} draft pick(s) included.` : ''}`, time: (t.status_updated ?? t.created) ? new Date((t.status_updated ?? t.created)!).toISOString() : '' })),
    playoffSpots: spots,
    playoffNote: `Your team ranks #${rank} by record and points for${spots != null ? ` with ${spots} playoff spots configured` : ''}. This is a standings summary; division rules and remaining schedules can change qualification. Playoff odds need a projection model.`,
  };
}

/** Presentation only: ownership and alerts have already been resolved by the authenticated service. */
export function fromCommandCenter(response: import('@sleeper/domain').CommandCenterResponse): DashboardData {
  const snapshot = response.sections.snapshot.data;
  if (!snapshot) throw new Error('League snapshot unavailable.');
  const { league, roster, rosters, users, matchups, transactions, players } = snapshot;
  const details: LeagueDetails = {
    scoring: response.sections.scoring.data ?? scoringUnavailable(),
    league: { league_id: league.id, name: league.name, season: league.season, status: league.status,
      roster_positions: league.rosterPositions.map(s => s.position), scoring_settings: {}, settings: league.settings ?? {}, total_rosters: league.totalRosters ?? rosters.length },
    rosters: rosters.map(r => ({ roster_id: r.rosterId, owner_id: r.ownerId, co_owners: r.coOwnerIds, players: r.playerIds, starters: r.starterIds, settings: r.settings })),
    users: users.map(u => ({ user_id: u.id, username: u.username, display_name: u.displayName, avatar: u.avatarId })),
    matchups: matchups.map(m => ({ roster_id: m.rosterId, matchup_id: m.matchupId, points: m.points, custom_points: m.customPoints ?? undefined, players: m.playerIds, starters: m.starterIds })),
    transactions: transactions.map(t => ({ transaction_id: t.id, type: t.type, status: t.status, roster_ids: t.rosterIds, adds: t.adds, drops: t.drops,
      draft_picks: t.draftPicks.map(p => ({ season: p.season, round: p.round, roster_id: p.rosterId, owner_id: p.ownerId, previous_owner_id: p.previousOwnerId ?? undefined })),
      status_updated: Date.parse(t.sourceUpdatedAt ?? t.synchronizedAt) })),
    players: Object.fromEntries(players.map(p => [p.id, { player_id: p.id, full_name: p.fullName, position: p.position, team: p.team, status: p.status, injury_status: p.injuryStatus }])),
    lastSyncedAt: roster.synchronizedAt,
  };
  // Select the server-resolved roster, including rosters managed only through co-ownership.
  const ownerId = roster.ownerId ?? roster.coOwnerIds[0];
  const data = fromLeagueDetails(details, ownerId, response.week, null, response.rosterId);
  data.alerts = sortAlerts((response.sections.alerts.data ?? []).map(alert => ({ ...alert,
    action: { id: alert.id, kind: 'start', title: alert.title, reason: alert.detail, checklist: checklistFor('start') } })));
  data.coverageNote = response.sections.alerts.warnings.join(' ') || undefined;
  if (data.matchup && response.sections.matchup.data?.opponentRosterId != null) {
    data.matchup.risks = ['Player availability can change before kickoff. Review the league-scored outlook below.'];
  }
  return data;
}
