import { interpretLeagueRules, scoringFormatLabel, type TradeAsset, type TradeBounds, type TradeCandidate, type TradeNeed, type TradeOffer, type TradeReport, type TradeStrategy, type TradeTeamEvaluation, type TradeTeamImpact, type TradedDraftPick, type User } from '@sleeper/domain';
import { parseWaiverSignals, type PlayerSignal } from './waiver-signals.js';
import { scoreLeagueForecasts, TRADE_UNAVAILABLE_STATUSES, weekPoints } from './projection-scoring.js';
import type { WaiverInput } from './waivers.js';
import { optimizeTradeLineup } from './trade-lineup.js';

export interface TradeInput extends WaiverInput { tradedPicks?: TradedDraftPick[]; users?: User[]; bounds?: Partial<TradeBounds> }
export const defaultTradeBounds: TradeBounds = { maxValueGap: .25, maxRisk: .65, minNeedGain: .5, maxRebuilderLineupLoss: .1, maxResults: 8, maxAssetsPerTeam: 18 };
export function parseTradeBounds(value: unknown): TradeBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trade bounds must be an object.');
  const bounds = { ...defaultTradeBounds, ...value };
  for (const [key, v] of Object.entries(bounds)) {
    if (!(key in defaultTradeBounds) || typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Unknown or nonnumeric trade bound.');
    const max = key === 'minNeedGain' ? 50 : key === 'maxResults' ? 30 : key === 'maxAssetsPerTeam' ? 30 : 1;
    const min = ['maxResults', 'maxAssetsPerTeam'].includes(key) ? 1 : key === 'minNeedGain' ? .01 : 0;
    if (v < min || v > max || (['maxResults', 'maxAssetsPerTeam'].includes(key) && !Number.isInteger(v))) throw new Error(`Invalid trade bound: ${key}.`);
  }
  return bounds;
}
const round = (v: number) => Math.round(v * 100) / 100;
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const mean = (v: number[]) => v.length ? sum(v) / v.length : 0;
const unavailable = (s?: string | null) => TRADE_UNAVAILABLE_STATUSES.includes((s ?? '').toLowerCase());
const ids = (r: WaiverInput['rosters'][number]) => [...new Set([...r.playerIds, ...r.starterIds, ...r.reserveIds, ...r.taxiIds].filter(id => id && id !== '0'))];

/** Model units, not market prices. Age adjustment and discounted career horizon are explicit heuristics. */
export function valueTradePlayer(signal: PlayerSignal, ros: number, future: number, dynasty: boolean, strategy: TradeStrategy = 'balanced') {
  if (!dynasty) return Math.max(0, ros);
  const years = signal.expectedCareerYears!;
  const horizon = sum(Array.from({ length: Math.min(5, Math.ceil(years)) }, (_, i) => Math.min(1, years - i) * .82 ** i));
  const ageFactor = Math.max(.5, Math.min(1.15, 1 + (27 - signal.age!) * .02));
  const currentWeight = strategy === 'contender' ? .65 : strategy === 'rebuilder' ? .2 : .4;
  return Math.max(0, currentWeight * ros + (1 - currentWeight) * future * horizon / 3 * ageFactor);
}

/** All proposals and fallbacks pass the same bilateral needs, ownership, legality, fairness and risk gates. */
export function recommendTrades(input: TradeInput): TradeReport {
  const { league, week } = input, rules = interpretLeagueRules(league), dynasty = rules.format === 'dynasty';
  const bounds = parseTradeBounds(input.bounds ?? {}), now = input.now ?? new Date();
  const report: TradeReport = { leagueId: league.id, rosterId: input.rosterId, week, format: rules.format, bounds, scoring: rules.scoring.configuration,
    scoringSnapshotId: rules.scoring.snapshotId, scoringLabel: scoringFormatLabel(rules.scoring.configuration), forecastUpdatedAt: null, rejected: [],
    status: 'unavailable', source: null, warnings: [], teams: [], candidates: [],
    methodology: 'Model units derived from this league’s own scoring applied to raw stat forecasts, not market prices, acceptance odds or a provider’s fantasy-point totals. Fairness checks neutral package balance and each manager’s strategy-adjusted value. Needs use league-relative position strength, depth and dynasty longevity/capital. Contention is a heuristic from projected strength and record; manager preferences remain unknown.' };
  const fail = (message: string) => { report.warnings.push(message); return report; };
  if (!rules.scoring.actionable) { report.warnings.push('Validated complete live scoring is required. Lineup, waiver and trade rankings are unavailable.', ...rules.scoring.configuration.issues.map(issue => issue.message)); return report; }
  const rosters = input.rosters.filter(r => r.leagueId === league.id);
  if (!Number.isInteger(week) || week < 1 || week > 18) return fail('Select a week from 1 to 18.');
  if (!rosters.some(r => r.rosterId === input.rosterId)) throw new Error('Selected roster does not belong to this league.');
  if (rosters.length < 2 || new Set(rosters.map(r => r.rosterId)).size !== rosters.length || (league.totalRosters != null && rosters.length !== league.totalRosters)) return fail('Complete, unique league roster coverage is required.');
  if (rules.format === 'keeper') return fail('Keeper costs and retention rules are not supplied; redraft or dynasty values would misprice this league.');
  if (!rules.roster.starters.length) return fail('No starting lineup rules are available.');
  if (league.settings?.disable_trades === 1 || (league.settings?.trade_deadline != null && league.settings.trade_deadline > 0 && week > league.settings.trade_deadline) || league.status === 'complete') return fail('Trading is disabled, the deadline has passed, or the season is complete.');
  let signals;
  try { signals = input.signals && parseWaiverSignals(input.signals); } catch { return fail('Forecast validation failed. Repair the source before evaluating trades.'); }
  if (!signals || signals.season !== league.season || signals.week !== week) return fail('A matching forecast source is required. No sample values are used for connected leagues.');
  report.source = { name: signals.source, updatedAt: signals.updatedAt };
  report.forecastUpdatedAt = signals.updatedAt;
  const sourceAge = now.getTime() - Date.parse(signals.updatedAt);
  if (sourceAge > 48 * 60 * 60_000 || sourceAge < -5 * 60_000) return fail('Forecasts are stale or future-dated. Refresh the source before evaluating trades.');
  if (rosters.some(r => !Number.isFinite(Date.parse(r.synchronizedAt)) || now.getTime() - Date.parse(r.synchronizedAt) > 10 * 60_000 || now.getTime() - Date.parse(r.synchronizedAt) < -5 * 60_000)) return fail('Roster ownership is stale or unverified. Refresh every roster before generating trades.');
  if (rosters.some(r => r.reserveIds.length > rules.roster.reserveSlots || r.taxiIds.length > rules.roster.taxiSlots || r.reserveIds.some(id => r.taxiIds.includes(id)))) return fail('Reserve/taxi roster constraints are invalid. Resolve them before trading.');
  const policy = signals.leagues?.[league.id];
  const seasonEnd = rules.playoffs.startsWeek == null ? 18 : Math.min(18, rules.playoffs.startsWeek + (rules.playoffs.rounds ?? 1) - 1 + Number(rules.playoffs.twoWeekChampionship));
  const weeks = Array.from({ length: Math.max(0, seasonEnd - week + 1) }, (_, i) => i + week);
  if (!weeks.length) return fail('The selected week is after the fantasy season.');
  const meta = new Map(input.players.map(p => [p.id, p])), forecasts = new Map(signals.players.map(s => [s.playerId, s]));
  const allRostered = rosters.flatMap(ids);
  if (new Set(allRostered).size !== allRostered.length) return fail('A player appears on multiple rosters; ownership must be repaired first.');
  // The single input boundary: raw stat forecasts become league-scored points exactly once, here.
  // Trade valuation is conservative, so an undated absence removes a player for the whole horizon.
  const scored = scoreLeagueForecasts({
    rules: rules.scoring, signals, players: input.players, requiredWeeks: weeks,
    availability: { policy: 'entire-horizon', statuses: TRADE_UNAVAILABLE_STATUSES }, scoredAt: now,
  });
  report.rejected = scored.rejected;
  if (scored.rejected.length) report.warnings.push(`${scored.rejected.length} projection(s) were refused because their raw-stat units, player identity or scenario consistency could not be validated. They are excluded rather than valued at zero.`);
  const players = new Map<string, { asset: TradeAsset; signal: PlayerSignal; weekly: Map<number, number>; ros: number; future: number }>();
  for (const id of allRostered) {
    const p = meta.get(id), s = forecasts.get(id), value_ = scored.byPlayerId.get(id);
    const positions = value_?.positions ?? [];
    if (!p || !s || !value_ || !positions.length || (dynasty && (s.age == null || s.expectedCareerYears == null || !s.dynastyStats))) {
      const refusal = scored.rejected.find(rejection => rejection.playerId === id);
      if (refusal) report.warnings.push(refusal.message);
      return fail(`Incomplete roster forecasts${dynasty ? ', age or career horizons' : ''}. Every rostered player needs remaining-week stats and explicit bye flags.`);
    }
    const weekly = new Map(weeks.map(w => [w, value_.weeks.find(f => f.week === w)!.points]));
    const ros = mean([...weekly.values()]), future = value_.dynasty?.points ?? 0;
    const risk = Math.max(s.uncertainty ?? .35, unavailable(s.injuryStatus ?? p.injuryStatus ?? p.status) ? .8 : (s.injuryStatus ?? p.injuryStatus) ? .45 : 0);
    const value = valueTradePlayer(s, ros, future, dynasty);
    if (![...weekly.values(), value, future].every(Number.isFinite)) return fail('A forecast produced a nonfinite score.');
    const current = value_.weeks.find(f => f.week === week)!;
    const asset: TradeAsset = { id, kind: 'player', name: p.fullName, positions, value: round(value), risk, age: s.age ?? null, careerYears: s.expectedCareerYears ?? null,
      explanation: dynasty ? `Age ${s.age}; expected career ${s.expectedCareerYears} years. ${round(ros)} remaining-week points and ${round(future)} future typical-week points under your league's ${report.scoringLabel} scoring; age-adjusted career discounted 18% per year, capped at five years. Current production weight: contender 65%, balanced 40%, rebuilder 20%.` : `${round(ros)} average remaining-week points under your league's ${report.scoringLabel} scoring, including byes and known absences. No age or draft-pick premium.`,
      scoring: { snapshotId: value_.scoringSnapshotId, label: report.scoringLabel, weeklyPoints: round(current.points), ...(({ explanation, contributions }) => ({ explanation, contributions }))(weekPoints(rules.scoring, current)) } };
    players.set(id, { asset, signal: s, weekly, ros, future });
  }
  const canPlay = (id: string, w: number) => {
    const p = players.get(id)!, f = p.signal.weeks.find(f => f.week === w)!;
    const status = p.signal.injuryStatus ?? meta.get(id)?.injuryStatus ?? meta.get(id)?.status;
    return !f.bye && !(p.signal.unavailableThroughWeek != null ? w <= p.signal.unavailableThroughWeek : unavailable(status));
  };
  const lineup = (active: string[], w = week) => optimizeTradeLineup(active.filter(id => canPlay(id, w)).map(id => ({ id, name: players.get(id)!.asset.name, positions: players.get(id)!.asset.positions, points: players.get(id)!.weekly.get(w)! })), rules.roster);
  const capitalKnown = dynasty && Boolean(policy?.rookieDrafts?.length) && input.tradedPicks !== undefined;
  if (dynasty && !capitalKnown) report.warnings.push('Complete future rookie draft definitions and synced pick transfers are missing. Draft capital is unknown and pick offers are excluded.');
  const picksByRoster = new Map(rosters.map(r => [r.rosterId, [] as TradeAsset[]]));
  if (capitalKnown) {
    const transfers = new Map<string, TradedDraftPick>();
    for (const pick of input.tradedPicks!) {
      if (pick.leagueId !== league.id) continue;
      const key = `${pick.season}:${pick.round}:${pick.rosterId}`;
      if (transfers.has(key) || !picksByRoster.has(pick.ownerId) || !picksByRoster.has(pick.rosterId)) return fail('Draft pick ownership is inconsistent. Refresh transfers before evaluating dynasty trades.');
      transfers.set(key, pick);
    }
    for (const draft of policy!.rookieDrafts!) {
      const years = Number(draft.season) - Number(league.season);
      if (years < 1 || years > 5) return fail('Rookie draft definitions must describe upcoming seasons within five years.');
      for (const r of rosters) for (let roundNumber = 1; roundNumber <= draft.rounds; roundNumber++) {
        const key = `${draft.season}:${roundNumber}:${r.rosterId}`, owner = transfers.get(key)?.ownerId ?? r.rosterId;
        // Mid-round model units: original team's future finish is unknown, not extrapolated from one season.
        const value = 18 / roundNumber ** 1.35 * .85 ** (years - 1);
        picksByRoster.get(owner)!.push({ id: `pick:${key}`, kind: 'pick', name: `${draft.season} round ${roundNumber} rookie pick (roster ${r.rosterId})`, positions: [], value: round(value), risk: .55, age: null, careerYears: null, scoring: null, explanation: `Currently owned by roster ${owner}. Mid-round heuristic, discounted 15% per future year. Final pick slot, rookie class strength and development are unknown. A pick has no stat line, so no league scoring applies.` });
      }
    }
  }
  const activeByRoster = new Map(rosters.map(r => [r.rosterId, ids(r).filter(id => !r.reserveIds.includes(id) && !r.taxiIds.includes(id))]));
  const beforeByRoster = new Map(rosters.map(r => [r.rosterId, lineup(activeByRoster.get(r.rosterId)!)]));
  const positions = [...new Set(rules.roster.starters.flatMap(s => rules.roster.eligiblePositions(s.position)))];
  const metrics = (active: string[], picks: TradeAsset[]) => {
    const start = lineup(active), starters = new Set(start.slots.flatMap(s => s.playerId ? [s.playerId] : []));
    const result: Record<string, number> = { capital: sum(picks.map(p => p.value)) };
    for (const pos of positions) {
      const at = active.filter(id => players.get(id)!.asset.positions.includes(pos));
      result[`starter:${pos}`] = sum(start.slots.filter(s => s.playerId && players.get(s.playerId)!.asset.positions.includes(pos)).map(s => s.points));
      result[`depth:${pos}`] = sum(at.filter(id => !starters.has(id)).map(id => Math.max(0, players.get(id)!.ros)).sort((a, b) => b - a).slice(0, 2));
      result[`longevity:${pos}`] = sum(at.map(id => valueTradePlayer(players.get(id)!.signal, players.get(id)!.ros, players.get(id)!.future, dynasty, 'rebuilder')).sort((a, b) => b - a).slice(0, 2));
    }
    return { values: result, lineup: start };
  };
  const baseline = new Map(rosters.map(r => [r.rosterId, metrics(activeByRoster.get(r.rosterId)!, picksByRoster.get(r.rosterId)!)]));
  const averages = Object.fromEntries(Object.keys(baseline.values().next().value!.values).map(key => [key, mean([...baseline.values()].map(v => v.values[key]))]));
  for (const roster of rosters) {
    const rank = 1 + rosters.filter(r => beforeByRoster.get(r.rosterId)!.points > beforeByRoster.get(roster.rosterId)!.points).length;
    const games = (roster.settings.wins ?? 0) + (roster.settings.losses ?? 0) + (roster.settings.ties ?? 0);
    const winRate = games ? ((roster.settings.wins ?? 0) + .5 * (roster.settings.ties ?? 0)) / games : .5;
    const ties = rosters.filter(r => beforeByRoster.get(r.rosterId)!.points === beforeByRoster.get(roster.rosterId)!.points).length;
    const strength = .7 * (rosters.length - rank - (ties - 1) / 2) / Math.max(1, rosters.length - 1) + .3 * winRate;
    const override = policy?.tradeStrategies?.[String(roster.rosterId)];
    const strategy: TradeStrategy = override ?? (strength >= .6 ? 'contender' : dynasty && strength <= .35 ? 'rebuilder' : 'balanced');
    const own = baseline.get(roster.rosterId)!, needs: TradeNeed[] = [];
    for (const [key, current] of Object.entries(own.values)) {
      const [kind, pos] = key.split(':') as [TradeNeed['kind'], string | undefined];
      if ((kind === 'longevity' || kind === 'capital') && (!dynasty || strategy !== 'rebuilder')) continue;
      if (kind === 'capital' && !capitalKnown) continue;
      const aging = mean(activeByRoster.get(roster.rosterId)!.map(id => players.get(id)!.signal.expectedCareerYears ?? 0)) < 3;
      const target = kind === 'capital' && aging ? Math.max(averages[key], current + 5) : averages[key];
      if (target - current < bounds.minNeedGain) continue;
      needs.push({ key, kind, position: pos ?? null, current: round(current), target: round(target), explanation: kind === 'capital' ? `Rebuilding draft capital: ${round(current)} units${aging ? '; short remaining career horizons increase replenishment needs' : ' below league-average capital'}.` : `${pos} ${kind}: ${round(current)} versus ${round(target)} league-average units.` });
    }
    const name = input.users?.find(u => u.id === roster.ownerId)?.displayName ?? `Roster ${roster.rosterId}`;
    const active = activeByRoster.get(roster.rosterId)!;
    const surplus = active.filter(id => {
      const after = lineup(active.filter(other => other !== id));
      return after.legal && after.points >= own.lineup.points;
    }).map(id => players.get(id)!.asset);
    report.teams.push({ rosterId: roster.rosterId, name, strategy, strategyReason: override ? `Manager strategy supplied by league policy: ${strategy}.` : `Projected lineup rank ${rank}/${rosters.length}; ${games ? `${round(winRate * 100)}% win rate over ${games} games` : 'no completed record; neutral record weight'}. ${strategy} is a planning heuristic, not playoff odds.`, needs, surplus, lineup: own.lineup, futureCapital: capitalKnown ? { value: round(own.values.capital), picks: picksByRoster.get(roster.rosterId)! } : null });
  }
  const team = (id: number) => report.teams.find(t => t.rosterId === id)!;
  const valueFor = (asset: TradeAsset, strategy: TradeStrategy) => asset.kind === 'pick' ? asset.value * (strategy === 'rebuilder' ? 1.15 : strategy === 'contender' ? .85 : 1)
    : valueTradePlayer(players.get(asset.id)!.signal, players.get(asset.id)!.ros, players.get(asset.id)!.future, dynasty, strategy);
  const packageValue = (assets: TradeAsset[], strategy?: TradeStrategy) => sum(assets.map(a => strategy ? valueFor(a, strategy) : a.value));
  const user = team(input.rosterId);
  const assetsFor = (t: TradeTeamEvaluation) => [...activeByRoster.get(t.rosterId)!.filter(id => players.get(id)!.signal.tradeEligible !== false && !policy?.protectedTradeIds?.includes(id)).map(id => players.get(id)!.asset), ...(rules.tradedDraftPicks ? picksByRoster.get(t.rosterId)! : [])]
    .filter(a => a.value > 0 && a.risk <= bounds.maxRisk).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const shortlisted = new Map(report.teams.map(t => {
    const assets = assetsFor(t);
    if (assets.length > bounds.maxAssetsPerTeam) report.warnings.push(`${t.name}: search limited to the ${bounds.maxAssetsPerTeam} highest-valued eligible assets.`);
    return [t.rosterId, assets.slice(0, bounds.maxAssetsPerTeam)];
  }));
  const packages = (t: TradeTeamEvaluation) => {
    const assets = shortlisted.get(t.rosterId)!;
    const result = assets.map(a => [a]);
    // Two-asset offers must include a pick or verified surplus, reducing speculative depth stripping.
    for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) if ([assets[i], assets[j]].some(a => a.kind === 'pick' || t.surplus.some(s => s.id === a.id))) result.push([assets[i], assets[j]]);
    return result;
  };
  const impact = (t: TradeTeamEvaluation, give: TradeAsset[], receive: TradeAsset[]): { impact: TradeTeamImpact; active: string[] } | null => {
    const active = activeByRoster.get(t.rosterId)!.filter(id => !give.some(a => a.id === id)).concat(receive.filter(a => a.kind === 'player').map(a => a.id));
    if (active.length > rules.roster.starters.length + rules.roster.benchSlots || Object.entries(policy?.positionLimits ?? {}).some(([pos, cap]) => active.filter(id => players.get(id)!.asset.positions.includes(pos)).length > cap)) return null;
    const picks = picksByRoster.get(t.rosterId)!.filter(p => !give.some(a => a.id === p.id)).concat(receive.filter(a => a.kind === 'pick'));
    const after = metrics(active, picks);
    const lossBound = dynasty && t.strategy === 'rebuilder' ? bounds.maxRebuilderLineupLoss : 0;
    if (!after.lineup.legal || after.lineup.points + .001 < t.lineup.points * (1 - lossBound)) return null;
    const delivered = packageValue(give, t.strategy), received = packageValue(receive, t.strategy);
    if (received + .001 < delivered * (1 - bounds.maxValueGap)) return null;
    const improvements = t.needs.flatMap(need => {
      const gain = after.values[need.key] - baseline.get(t.rosterId)!.values[need.key];
      // An incoming asset must actually address the named need, not merely rearrange existing starters.
      const fits = receive.some(a => need.kind === 'capital' ? a.kind === 'pick' : a.positions.includes(need.position!));
      return fits && gain + .001 >= bounds.minNeedGain ? [{ need, after: round(after.values[need.key]), gain: round(gain) }] : [];
    });
    if (!improvements.length) return null;
    return { active, impact: { rosterId: t.rosterId, name: t.name, strategy: t.strategy, before: t.lineup, after: after.lineup, valueDelivered: round(delivered), valueReceived: round(received), needImprovements: improvements } };
  };
  const offers: TradeOffer[] = [], ownPackages = packages(user);
  for (const partner of report.teams.filter(t => t.rosterId !== input.rosterId)) {
    for (const give of ownPackages) for (const receive of packages(partner)) {
      if (give.length + receive.length > 3) continue;
      const sent = packageValue(give), got = packageValue(receive), gap = Math.abs(sent - got) / Math.max(sent, got);
      if (gap > bounds.maxValueGap) continue;
      const own = impact(user, give, receive); if (!own) continue;
      const other = impact(partner, receive, give); if (!other) continue;
      // Absolute legal coverage through the remaining fantasy schedule, including known bye/injury weeks.
      if (weeks.some(w => !lineup(own.active, w).legal || !lineup(other.active, w).legal)) continue;
      const risk = Math.max(...give.concat(receive).map(a => a.risk), Math.max(0, user.lineup.points - own.impact.after.points) / Math.max(1, user.lineup.points), Math.max(0, partner.lineup.points - other.impact.after.points) / Math.max(1, partner.lineup.points));
      if (risk > bounds.maxRisk) continue;
      offers.push({ id: `${partner.rosterId}:${give.map(a => a.id).join('+')}:${receive.map(a => a.id).join('+')}`, give, receive, user: own.impact, partner: other.impact, valueGap: round(gap), risk: round(risk),
        whyAccept: [...other.impact.needImprovements.map(i => `${partner.name} receives ${give.filter(a => i.need.kind === 'capital' ? a.kind === 'pick' : a.positions.includes(i.need.position!)).map(a => a.name).join(' + ')} to improve ${i.need.position ?? 'draft'} ${i.need.kind} by ${i.gain} units.`), `${partner.strategy} plan: projected lineup ${partner.lineup.points} → ${other.impact.after.points}; all remaining-week lineups retain legal coverage.`, 'This is a roster-fit rationale. Personal preferences, league context and negotiation determine acceptance; a value score does not predict it.'],
        risks: ['Forecasts and player roles can change; model values are estimates, not market prices.', ...give.concat(receive).filter(a => a.risk >= .4).map(a => `${a.name}: ${Math.round(a.risk * 100)}/100 uncertainty index${a.kind === 'pick' ? '; final draft slot and rookie outcome unknown' : '; availability or projection uncertainty'}.`), ...(dynasty ? ['Age curves and career horizons are uncertain; future production is discounted, not guaranteed.'] : []), ...[own.impact, other.impact].filter(i => i.after.points < i.before.points).map(i => `${i.name} sacrifices ${round(i.before.points - i.after.points)} projected points for its rebuilding plan.`), 'Bench coverage may shrink. Recheck injuries and league restrictions before submitting manually.'] });
    }
  }
  const gain = (o: TradeOffer) => sum(o.user.needImprovements.map(i => i.gain)) + (o.user.after.points - o.user.before.points);
  offers.sort((a, b) => gain(b) - gain(a) || a.risk - b.risk || a.valueGap - b.valueGap || a.id.localeCompare(b.id));
  report.candidates = offers.slice(0, bounds.maxResults).map((offer): TradeCandidate => {
    const fallback = offers.filter(o => o.partner.rosterId === offer.partner.rosterId && o.user.valueDelivered < offer.user.valueDelivered - .01 && o.user.needImprovements.some(i => offer.user.needImprovements.some(j => j.need.key === i.need.key)))
      .sort((a, b) => a.user.valueDelivered - b.user.valueDelivered || gain(b) - gain(a))[0] ?? null;
    return { ...offer, fallback, fallbackReason: fallback ? `Costs ${round(offer.user.valueDelivered - fallback.user.valueDelivered)} fewer strategy-adjusted units while improving the same weakness. The target or package may differ; both teams still pass all gates.` : 'No cheaper offer to this manager improves the same weakness within the selected bounds. Hold or broaden the search; do not strip value from this offer blindly.' };
  });
  report.status = report.warnings.length ? 'partial' : 'ready';
  if (!report.candidates.length) report.warnings.push('No mutually useful trades passed the need, legal-lineup, fairness and risk bounds. Holding is a valid outcome.');
  report.warnings.push('Search covers one-for-one and two-for-one alternatives, not every possible multi-asset trade. Offers are independent; none have been sent.');
  return report;
}
