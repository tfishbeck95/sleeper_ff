import { interpretLeagueRules, type CommandCenterResponse, type DashboardSection, type SectionState, type SourceFreshness, type StarterAlert, type TradeBounds } from '@sleeper/domain';
import { analyzeLineup, type LineupInput } from './lineup.js';
import { recommendWaivers } from './waivers.js';
import { recommendTrades } from './trades.js';
import type { ApplicationUser, JsonStore } from './store.js';
import type { LeagueSyncService } from './sync.js';
import { immutableSnapshot, validatedForecastSnapshot, type WaiverSignalProvider, type WaiverSignals } from './waiver-signals.js';

export class DashboardAccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const engines = { lineup: analyzeLineup, waivers: recommendWaivers, trades: recommendTrades };
const minute = 60_000;
function freshness(at: string | null | undefined, ttl: number, now: number): SectionState {
  if (!at) return 'unavailable';
  const age = now - Date.parse(at);
  return !Number.isFinite(age) || age < -5 * minute || age > ttl ? 'stale' : 'ready';
}

/** Request-scoped orchestration: authorize, sync once, read once, validate once, then isolate engines. */
export class CommandCenterService {
  constructor(private readonly store: JsonStore, private readonly sync: Pick<LeagueSyncService, 'syncLeague'>,
    private readonly provider: WaiverSignalProvider, private readonly engine = engines,
    private readonly clock = () => new Date()) {}

  async load(user: ApplicationUser, leagueId: string, week: number, bounds?: Partial<TradeBounds>): Promise<CommandCenterResponse> {
    if (!user.sleeperLeagueIds.includes(leagueId)) throw new DashboardAccessError(403, 'This league is not linked to the authenticated account.');
    if (!user.sleeperUserId || !Number.isInteger(week) || week < 1 || week > 18) throw new DashboardAccessError(400, 'Link a Sleeper account and provide an integer week from 1 to 18.');
    let syncFailed = false;
    try { await this.sync.syncLeague(leagueId, week); } catch { syncFailed = true; }
    const now = this.clock();
    const context = await this.store.dashboardContext(leagueId, week, now.getTime());
    if (!context.league) throw new DashboardAccessError(404, 'League not synced.');
    const owner = context.rosters.find(r => r.ownerId === user.sleeperUserId || r.coOwnerIds.includes(user.sleeperUserId!));
    if (!owner) throw new DashboardAccessError(403, 'This account does not own or co-own a roster in the selected league.');
    let forecast: WaiverSignals | null = null;
    let forecastError = false;
    try {
      const loaded = await this.provider.load(context.league.season, week);
      if (loaded) {
        const validated = validatedForecastSnapshot(loaded);
        if (validated.season === context.league.season && validated.week === week) forecast = validated;
      }
    } catch { forecastError = true; }
    // The selected week's submitted starters drive alerts, lineup totals and trade comparisons alike.
    const rosters = context.rosters.map(r => ({ ...r, starterIds: context.matchups.find(m => m.rosterId === r.rosterId)?.starterIds ?? r.starterIds }));
    const input: LineupInput = immutableSnapshot({ ...context, league: context.league, rosters, rosterId: owner.rosterId, week, signals: forecast, now });
    const rules = interpretLeagueRules(input.league);
    const provenance = { scoringSnapshotId: rules.scoring.snapshotId, forecastUpdatedAt: forecast?.updatedAt ?? null };
    const section = <T>(data: T | null, state: SectionState, warnings: string[] = []): DashboardSection<T> => ({ data, state, warnings, provenance });
    const syncWarnings = syncFailed ? ['League synchronization failed. Showing the retained snapshot; verify current ownership and availability in Sleeper.'] : [];
    const rosterState = rosters.some(r => freshness(r.synchronizedAt, 10 * minute, now.getTime()) !== 'ready') ? 'stale' : 'ready';
    const scoringState = freshness(rules.scoring.configuration.synchronizedAt, 30 * minute, now.getTime());
    const engineWarnings = [...syncWarnings, ...(rosterState === 'stale' ? ['Roster ownership is stale or future-dated. Refresh before acting on recommendations.'] : []), ...(scoringState === 'stale' ? ['The scoring observation is stale or future-dated. Refresh league rules before acting.'] : [])];
    const forecastState = forecastError ? 'error' : freshness(forecast?.updatedAt, 48 * 60 * minute, now.getTime());
    const forecastWarnings = forecastError ? ['The forecast source could not be loaded or failed validation.']
      : forecastState === 'unavailable' ? ['No validated forecast is available for the selected season and week.']
        : forecastState === 'stale' ? ['Forecasts are over 48 hours old or future-dated. Refresh the source before using recommendations.'] : [];
    async function run<T extends { status: 'ready' | 'partial' | 'unavailable'; warnings: string[] }>(name: string, evaluate: () => T | Promise<T>): Promise<DashboardSection<T>> {
      try {
        const report = await evaluate();
        const state = forecastState === 'error' ? 'error' : forecastState === 'stale' || rosterState === 'stale' || scoringState === 'stale' ? 'stale'
          : report.status === 'ready' && syncFailed ? 'partial' : report.status;
        return section(report, state, [...engineWarnings, ...forecastWarnings, ...report.warnings]);
      } catch { return section<T>(null, 'error', [`${name} analysis failed. Recheck to try again.`, ...syncWarnings]); }
    }
    const [lineup, waivers, trades] = await Promise.all([
      run('Lineup', () => this.engine.lineup(input)),
      run('Waiver', () => this.engine.waivers(input)),
      run('Trade', () => this.engine.trades({ ...input, bounds })),
    ]);
    // Even an engine that stops at a prerequisite cites the inputs selected for this response.
    if (lineup.data) lineup.data.forecast = forecast ? { source: forecast.source, updatedAt: forecast.updatedAt } : null;
    for (const result of [waivers, trades]) if (result.data) {
      result.data.forecastUpdatedAt = provenance.forecastUpdatedAt;
      result.data.source = forecast ? { name: forecast.source, updatedAt: forecast.updatedAt } : null;
    }
    const roster = rosters.find(r => r.rosterId === owner.rosterId)!;
    const alerts: StarterAlert[] = [];
    let missingPlayers = false;
    for (const [index, slot] of rules.roster.starters.entries()) {
      const id = roster.starterIds[index];
      const add = (kind: StarterAlert['kind'], title: string, detail: string) => alerts.push({ id: `${kind}-${index}`, kind, playerId: id && id !== '0' ? id : null, slot: slot.position, title, detail });
      if (!id || id === '0') { add('empty', `${slot.position} slot is empty`, 'Review eligible bench players before this slot locks.'); continue; }
      const player = input.players.find(p => p.id === id);
      if (!player) missingPlayers = true;
      const signal = forecastState === 'ready' ? forecast?.players.find(p => p.playerId === id) : undefined;
      const name = player?.fullName ?? `Player ${id}`;
      if (signal?.weeks.find(w => w.week === week)?.bye) add('bye', `${name} has a bye`, `Your ${slot.position} starter has no game in Week ${week}. Review a replacement.`);
      const status = (signal?.injuryStatus ?? player?.injuryStatus ?? player?.status ?? '').toLowerCase();
      if (['out', 'inactive', 'ir', 'injured reserve', 'suspended', 'pup', 'retired', 'deceased'].includes(status)) add('inactive', `${name} is ${status}`, 'Current availability flag. Verify the selected week and latest report in Sleeper.');
      else if (status && !['active', 'healthy'].includes(status)) add('injury', `${name}: ${status}`, 'Have an eligible backup ready and check the latest report.');
    }
    const sources: SourceFreshness[] = [
      { source: 'league', updatedAt: input.league.synchronizedAt, state: freshness(input.league.synchronizedAt, 30 * minute, now.getTime()) },
      { source: 'rosters', updatedAt: rosters.map(r => r.synchronizedAt).sort()[0] ?? null, state: rosterState },
      { source: 'scoring', updatedAt: rules.scoring.configuration.synchronizedAt, state: freshness(rules.scoring.configuration.synchronizedAt, 30 * minute, now.getTime()) },
      { source: 'forecast', updatedAt: forecast?.updatedAt ?? null, state: forecastState },
      ...['players:nfl', `users:${leagueId}`, `matchups:${leagueId}:${input.league.season}:${week}`, `transactions:${leagueId}:${input.league.season}:${week}`, `draftPicks:${leagueId}`].map(source => ({ source, updatedAt: context.freshness[source] ?? null, state: freshness(context.freshness[source], source === 'players:nfl' ? 24 * 60 * minute : source.startsWith('users:') ? 6 * 60 * minute : 10 * minute, now.getTime()) })),
    ];
    const metadataState = freshness(context.freshness['players:nfl'], 24 * 60 * minute, now.getTime());
    const alertWarnings = [...syncWarnings, ...(rosterState === 'stale' ? ['The roster snapshot is stale. Confirm current starters in Sleeper.'] : []), ...(metadataState !== 'ready' ? ['Player availability metadata is missing or stale; verify statuses in Sleeper.'] : []),
      ...(missingPlayers ? ['Some starters have no player metadata. Their availability is unknown.'] : []),
      ...(forecastState !== 'ready' ? ['Bye coverage is incomplete without a fresh forecast.'] : []),
      ...(!context.matchups.some(m => m.rosterId === owner.rosterId) ? ['No submitted lineup was synchronized for this week; current roster starters are shown.'] : [])];
    const visiblePlayerIds = new Set([...rosters.flatMap(r => [...r.playerIds, ...r.starterIds, ...r.reserveIds, ...r.taxiIds]), ...context.transactions.flatMap(t => [...Object.keys(t.adds), ...Object.keys(t.drops)])]);
    const matchup = lineup.data?.matchup;
    return {
      leagueId, rosterId: owner.rosterId, season: input.league.season, week, generatedAt: now.toISOString(), provenance,
      sections: {
        snapshot: section({ league: input.league, roster, rosters, users: context.users, matchups: context.matchups, transactions: context.transactions, players: input.players.filter(p => visiblePlayerIds.has(p.id)) }, rosterState === 'stale' ? 'stale' : syncFailed ? 'partial' : 'ready', [...syncWarnings, ...(rosterState === 'stale' ? ['The roster snapshot is stale. Refresh current ownership and starters.'] : [])]),
        scoring: section(rules.scoring.configuration, !rules.scoring.actionable ? 'unavailable' : sources[2].state, [...rules.scoring.configuration.issues.map(i => i.message), ...(scoringState === 'stale' ? ['The scoring observation is stale or future-dated.'] : [])]),
        alerts: section(alerts, rosterState === 'stale' || metadataState === 'stale' ? 'stale' : alertWarnings.length ? 'partial' : 'ready', alertWarnings),
        lineup, waivers, trades,
        matchup: section(matchup ?? null, lineup.state === 'error' || lineup.state === 'stale' ? lineup.state : matchup?.opponentRosterId == null ? 'unavailable' : matchup.winProbability.value == null && lineup.state === 'ready' ? 'partial' : lineup.state,
          [...lineup.warnings, ...(matchup?.opponentRosterId == null ? ['No scored opponent matchup is available for this week.'] : [])]),
        freshness: section(sources, sources.some(s => s.state !== 'ready') || syncFailed ? 'partial' : 'ready', [...syncWarnings, ...forecastWarnings]),
      },
    };
  }
}
