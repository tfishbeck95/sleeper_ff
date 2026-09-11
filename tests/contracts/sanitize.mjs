// Allowlist the contract fields we consume. Never recursively copy arbitrary metadata/free text.
// Mapping exists only in memory; no raw body, original URL, or reversible identity map is written.
export function sanitizer() {
  const maps = { user: new Map(), league: new Map(), draft: new Map(), transaction: new Map() };
  const id = (kind, value) => {
    if (value == null) return null;
    if (!maps[kind].has(String(value))) maps[kind].set(String(value), `${{ user: '91', league: '92', draft: '93', transaction: '94' }[kind]}${String(maps[kind].size + 1).padStart(16, '0')}`);
    return maps[kind].get(String(value));
  };
  const numberMap = value => Object.fromEntries(Object.entries(value ?? {}).filter(([,v]) => typeof v === 'number' && Number.isFinite(v)));
  const strings = value => value == null ? null : value.filter(v => typeof v === 'string');
  const pick = p => ({ season: p.season, round: p.round, roster_id: p.roster_id, owner_id: p.owner_id, ...(p.previous_owner_id == null ? {} : { previous_owner_id: p.previous_owner_id }) });
  const user = u => u == null ? null : ({ user_id: id('user', u.user_id), username: `fixture_user_${id('user', u.user_id).slice(-3)}`, display_name: `Fixture User ${id('user', u.user_id).slice(-3)}`, avatar: null });
  const league = l => ({ league_id: id('league', l.league_id), previous_league_id: id('league', l.previous_league_id),
    name: `Fixture League ${id('league', l.league_id).slice(-3)}`, season: l.season, season_type: l.season_type,
    status: l.status, sport: l.sport, total_rosters: l.total_rosters, avatar: null,
    roster_positions: strings(l.roster_positions), settings: numberMap(l.settings),
    ...(l.scoring_settings == null ? {} : { scoring_settings: numberMap(l.scoring_settings) }) });
  return {
    user, league, users: a => a.map(user), leagues: a => a.map(league),
    rosters: a => a.map(r => ({ roster_id: r.roster_id, owner_id: id('user', r.owner_id), co_owners: r.co_owners?.map(v => id('user', v)) ?? null,
      players: strings(r.players), starters: strings(r.starters), reserve: strings(r.reserve), taxi: strings(r.taxi), settings: numberMap(r.settings) })),
    matchups: a => a.map(m => ({ matchup_id: m.matchup_id, roster_id: m.roster_id, points: m.points, custom_points: m.custom_points,
      players: strings(m.players), starters: strings(m.starters), players_points: numberMap(m.players_points), starters_points: m.starters_points })),
    transactions: a => a.map(t => ({ transaction_id: id('transaction', t.transaction_id), type: t.type, status: t.status,
      status_updated: t.status_updated, created: t.created, roster_ids: t.roster_ids, adds: t.adds == null ? null : numberMap(t.adds),
      drops: t.drops == null ? null : numberMap(t.drops), draft_picks: (t.draft_picks ?? []).map(pick),
      waiver_budget: t.waiver_budget?.map(b => ({ sender: b.sender, receiver: b.receiver, amount: b.amount })) ?? [] })),
    drafts: a => a.map(d => ({ draft_id: id('draft', d.draft_id), league_id: id('league', d.league_id), season: d.season,
      status: d.status, type: d.type, sport: d.sport, settings: numberMap(d.settings), metadata: {} })),
    tradedPicks: a => a.map(pick),
    players: players => Object.fromEntries(Object.entries(players).map(([key, p]) => [key, Object.fromEntries([
      'player_id', 'first_name', 'last_name', 'full_name', 'position', 'fantasy_positions', 'team', 'status', 'injury_status',
    ].filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]]))])),
  };
}
