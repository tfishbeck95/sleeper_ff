import { interpretLeagueRules, scoringFormatLabel, type League, type NflPlayer, type Roster, type ScoringContribution, type WaiverHorizon, type WaiverNeed, type WaiverPlayer, type WaiverRecommendation, type WaiverReport } from '@sleeper/domain';
import { roleMultiplier, scoreLeagueForecasts, WAIVER_UNAVAILABLE_STATUSES, weekPoints, type ScoredForecasts } from './projection-scoring.js';
import type { PlayerSignal, WaiverSignals } from './waiver-signals.js';

export interface WaiverInput {
  league: League; rosters: Roster[]; players: NflPlayer[]; rosterId: number;
  week: number; signals: WaiverSignals | null; now?: Date;
}
const round = (v: number) => Math.round(v * 10) / 10;
const average = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const unavailable = (status?: string | null) => WAIVER_UNAVAILABLE_STATUSES.includes((status ?? '').toLowerCase());
const allIds = (roster: Roster) => [...new Set([...roster.playerIds, ...roster.starterIds, ...roster.reserveIds, ...roster.taxiIds].filter(id => id && id !== '0'))];
const positions = (p: NflPlayer) => p.fantasyPositions.length ? p.fantasyPositions : p.position ? [p.position] : [];
const identity = (p: NflPlayer): WaiverPlayer => ({ id: p.id, name: p.fullName, positions: positions(p), team: p.team });

/** Deterministic, owner-scoped add/drop analysis. Every pair is an independent alternative. */
export function recommendWaivers(input: WaiverInput): WaiverReport {
  const { league, week } = input;
  const now = input.now ?? new Date();
  const rules = interpretLeagueRules(league);
  const rosters = input.rosters.filter(r => r.leagueId === league.id);
  const roster = rosters.find(r => r.rosterId === input.rosterId);
  if (!roster) throw new Error('Selected roster does not belong to this league.');
  const rostered = new Set(rosters.flatMap(allIds));
  const report: WaiverReport = {
    leagueId: league.id, rosterId: roster.rosterId, week, season: league.season, generatedAt: now.toISOString(), rosterSyncedAt: roster.synchronizedAt,
    scoring: rules.scoring.configuration, scoringSnapshotId: rules.scoring.snapshotId, scoringLabel: scoringFormatLabel(rules.scoring.configuration),
    forecastUpdatedAt: null, rejected: [],
    source: null, status: 'unavailable', warnings: [], rosteredCount: rostered.size, eligibleCount: 0, evaluatedCount: 0, recommendations: [],
    submission: { supported: false, url: /^\d{1,30}$/.test(league.id) ? `https://sleeper.com/leagues/${league.id}` : null, instruction: 'Copy this plan, then submit claims manually in Sleeper. The supported Sleeper API is read-only; no claims have been submitted.' },
  };
  if (!rules.scoring.actionable) { report.warnings.push('Validated complete live scoring is required. Lineup, waiver and trade rankings are unavailable.', ...rules.scoring.configuration.issues.map(issue => issue.message)); return report; }
  if (league.totalRosters != null && rosters.length !== league.totalRosters) {
    report.warnings.push('League roster coverage is incomplete. Availability cannot be verified.'); return report;
  }
  if (league.settings?.disable_adds === 1 || league.status !== 'in_season') {
    report.warnings.push('Acquisitions are disabled or this league is not in season.'); return report;
  }
  const signals = input.signals;
  if (!signals || signals.season !== league.season || signals.week !== week) {
    report.warnings.push('No forecast source is configured for this season and week. League-scored projections, schedules, role trends and dynasty values are required to evaluate add/drop pairs.'); return report;
  }
  report.source = { name: signals.source, updatedAt: signals.updatedAt };
  report.forecastUpdatedAt = signals.updatedAt;
  const age = now.getTime() - Date.parse(signals.updatedAt);
  if (!Number.isFinite(age) || age > 48 * 60 * 60_000 || age < -5 * 60_000) {
    report.warnings.push('Forecast source is stale (over 48 hours) or has an invalid future timestamp. Refresh it before ranking claims.'); return report;
  }
  // The single input boundary: raw stat forecasts become league-scored points exactly once, here.
  const scored: ScoredForecasts = scoreLeagueForecasts({
    rules: rules.scoring, signals, players: input.players,
    availability: { policy: 'selected-week', selectedWeek: week, statuses: WAIVER_UNAVAILABLE_STATUSES }, scoredAt: now,
  });
  report.rejected = scored.rejected;
  if (scored.rejected.length) report.warnings.push(`${scored.rejected.length} projection(s) were refused because their raw-stat units or player identity could not be validated. They are excluded rather than scored as zero.`);
  if (now.getTime() - Date.parse(roster.synchronizedAt) > 10 * 60_000) report.warnings.push('Roster snapshot is over 10 minutes old. Refresh availability before submitting claims.');
  report.warnings.push('Availability is based on roster membership and supplied constraints. Confirm waiver locks, processing deadlines and commissioner restrictions in Sleeper.');
  const policy = signals.leagues?.[league.id];
  const players = new Map(input.players.map(p => [p.id, p]));
  const forecasts = new Map(signals.players.map(p => [p.playerId, p]));
  const own = allIds(roster).flatMap(id => players.has(id) ? [players.get(id)!] : []);
  const isEligible = (p: NflPlayer, slot: string) => positions(p).some(pos => rules.roster.eligiblePositions(slot).includes(pos));
  const fits = (p: NflPlayer) => rules.roster.starters.some(slot => isEligible(p, slot.position));
  const status = (p: NflPlayer, s?: PlayerSignal) => s?.injuryStatus ?? p.injuryStatus ?? p.status;
  // Points come only from the scoring boundary; a refused or absent forecast stays unknown, never zero.
  const scoredWeek = (id: string, w: number) => scored.byPlayerId.get(id)?.weeks.find(f => f.week === w);
  const points = (p: NflPlayer, w: number): number | null => {
    const s = forecasts.get(p.id);
    // A refused projection is unknown, not zero: a bye or absence never rescues it into a usable value.
    if (s && !scored.byPlayerId.has(p.id)) return null;
    const forecast = s?.weeks.find(f => f.week === w);
    if (forecast?.bye || (w === week && unavailable(status(p, s))) || (s?.unavailableThroughWeek != null && w <= s.unavailableThroughWeek)) return 0;
    const week_ = scoredWeek(p.id, w);
    if (!week_) return null;
    return round(week_.points);
  };
  const explain = (p: NflPlayer, w: number): { explanation: string; contributions: ScoringContribution[] } => {
    const week_ = scoredWeek(p.id, w);
    return week_ ? weekPoints(rules.scoring, week_) : { explanation: `No league-scored forecast covers ${p.fullName} in week ${w}.`, contributions: [] };
  };
  const playoffStart = rules.playoffs.startsWeek;
  const playoffEnd = playoffStart == null ? null : Math.min(18, playoffStart + (rules.playoffs.rounds ?? 1) - 1 + Number(rules.playoffs.twoWeekChampionship));
  const seasonEnd = playoffEnd ?? 18;
  const remainingWeeks = Array.from({ length: Math.max(0, seasonEnd - week + 1) }, (_, i) => week + i);
  if (!remainingWeeks.length) { report.warnings.push('The selected week is after this league’s playoff schedule.'); return report; }
  const playoffWeeks = playoffStart == null ? [] : remainingWeeks.filter(w => w >= playoffStart);
  const meanFor = (p: NflPlayer, weeks: number[]) => {
    const values = weeks.map(w => points(p, w));
    // Incomplete schedules are not silently treated as zero or favorable rest-of-season values.
    return values.length && values.every(v => v !== null) ? average(values as number[]) : null;
  };
  const value = (p: NflPlayer, horizon: WaiverHorizon): number | null => {
    if (horizon === 'streamer') return points(p, week);
    if (horizon === 'dynasty') return scored.byPlayerId.get(p.id)?.dynasty?.points ?? null;
    const ros = meanFor(p, remainingWeeks); const playoffs = meanFor(p, playoffWeeks);
    return ros == null ? null : round(playoffs == null ? ros : .75 * ros + .25 * playoffs);
  };
  const horizons: WaiverHorizon[] = ['streamer', 'rest-of-season', ...(rules.format === 'dynasty' ? ['dynasty' as const] : [])];
  const retention = (p: NflPlayer): number | null => {
    const ros = value(p, 'rest-of-season'); const dynasty = value(p, 'dynasty');
    if (ros == null || (rules.format === 'dynasty' && dynasty == null)) return null;
    return Math.max(points(p, week) ?? ros, ros, ...(rules.format === 'dynasty' ? [dynasty!] : []));
  };
  const protectedIds = new Set([...roster.starterIds, ...roster.reserveIds, ...roster.taxiIds, ...(policy?.protectedDropIds ?? [])]);
  const bench = own.filter(p => !protectedIds.has(p.id) && forecasts.get(p.id)?.droppable !== false && retention(p) !== null);
  const activeIds = allIds(roster).filter(id => !roster.reserveIds.includes(id) && !roster.taxiIds.includes(id));
  const capacity = rules.roster.starters.length + rules.roster.benchSlots;
  const freeSlot = activeIds.length < capacity;
  if (activeIds.length > capacity) { report.warnings.push('Your active roster is over capacity; one add/drop pair cannot resolve this. Correct the roster in Sleeper first.'); return report; }
  if (!freeSlot && !bench.length) report.warnings.push('No safe bench drop has complete retention forecasts. Starters, reserve/taxi players and protected players are never recommended as drops.');
  if (own.length < allIds(roster).length) report.warnings.push('Some rostered players have no player metadata; those players cannot be valued or recommended as drops.');
  const candidatePool = input.players.filter(p => !rostered.has(p.id) && fits(p) && forecasts.get(p.id)?.acquisitionEligible !== false && !policy?.blockedAddIds?.includes(p.id) && !['retired', 'deceased'].includes((p.status ?? '').toLowerCase()) && (p.team != null || rules.format === 'dynasty'));
  report.eligibleCount = candidatePool.length;
  const candidates = candidatePool.filter(p => scored.byPlayerId.has(p.id)); report.evaluatedCount = candidates.length;
  if (candidates.length < candidatePool.length) report.warnings.push(`${candidatePool.length - candidates.length} available players lack a validated, league-scored forecast and were not ranked.`);
  const active = own.filter(p => !roster.reserveIds.includes(p.id) && !roster.taxiIds.includes(p.id));
  const canPlay = (p: NflPlayer, w: number) => {
    const s = forecasts.get(p.id);
    return !s?.weeks.find(f => f.week === w)?.bye && !(w === week && unavailable(status(p, s))) && !(s?.unavailableThroughWeek != null && w <= s.unavailableThroughWeek);
  };
  // Maximum bipartite matching protects position coverage, including overlapping flex slots.
  const filledSlots = (pool: NflPlayer[], w: number) => {
    const assigned = new Map<string, number>();
    const place = (slotIndex: number, visited: Set<string>): boolean => {
      for (const p of pool) {
        if (visited.has(p.id) || !canPlay(p, w) || !isEligible(p, rules.roster.starters[slotIndex].position)) continue;
        visited.add(p.id);
        const prior = assigned.get(p.id);
        if (prior === undefined || place(prior, visited)) { assigned.set(p.id, slotIndex); return true; }
      }
      return false;
    };
    return rules.roster.starters.reduce((count, _, index) => count + Number(place(index, new Set())), 0);
  };
  const coverage = remainingWeeks.map(w => filledSlots(active, w));
  const legalPair = (add: NflPlayer, drop: NflPlayer | null) => {
    const after = active.filter(p => p.id !== drop?.id).concat(add);
    return Object.entries(policy?.positionLimits ?? {}).every(([pos, cap]) => after.filter(p => positions(p).includes(pos)).length <= cap)
      && remainingWeeks.every((w, index) => filledSlots(after, w) >= coverage[index]);
  };
  const budget = league.settings?.waiver_budget;
  const used = roster.settings.waiver_budget_used;
  const balance = policy?.faabRemaining?.[String(roster.rosterId)] ?? (budget != null && used != null ? Math.max(0, budget - used) : null);
  const faabEnabled = league.settings?.waiver_type === 2;
  if (faabEnabled && balance == null) report.warnings.push('FAAB balance is unavailable. No dollar range can be recommended.');
  if (faabEnabled && balance != null && policy?.faabRemaining?.[String(roster.rosterId)] == null) report.warnings.push('FAAB remaining is configured budget minus reported spending; confirm transfers and commissioner adjustments in Sleeper.');
  for (const add of candidates) for (const horizon of horizons) {
    const projected = value(add, horizon); if (projected == null || projected <= 0) continue;
    const s = forecasts.get(add.id)!;
    if (horizon === 'streamer' && (!add.team || unavailable(status(add, s)) || s.weeks.find(w => w.week === week)?.bye)) continue;
    const compatible = rules.roster.starters.flatMap((slot, index) => {
      if (!isEligible(add, slot.position)) return [];
      const id = roster.starterIds[index]; const player = players.get(id);
      const empty = !id || id === '0';
      return [{ player, value: empty ? 0 : player ? value(player, horizon) : null, empty }];
    });
    // All compatible starter baselines must be known before naming the weakest starter.
    const comparison = compatible.every(v => v.value !== null) ? [...compatible].sort((a, b) => a.value! - b.value!)[0] : undefined;
    const starterGain = comparison ? round(projected - comparison.value!) : null;
    const weak = [...bench].filter(p => value(p, horizon) !== null).sort((a, b) => value(a, horizon)! - value(b, horizon)! || a.id.localeCompare(b.id))[0];
    const benchGain = weak ? round(projected - value(weak, horizon)!) : null;
    const drops = [...bench].sort((a, b) => retention(a)! - retention(b)! || a.id.localeCompare(b.id));
    const drop = freeSlot ? null : drops.find(p => legalPair(add, p));
    if ((!freeSlot && !drop) || !legalPair(add, drop ?? null)) continue;
    const dropCost = drop ? retention(drop)! : 0;
    // A temporary upgrade must justify losing the bench player's longer-term value.
    const net = projected - dropCost;
    if (net <= 0 || (horizon === 'streamer' && (starterGain == null || starterGain <= 0))) continue;
    const currentStarter = comparison?.player;
    const currentSignal = currentStarter && forecasts.get(currentStarter.id);
    const need: WaiverNeed = horizon === 'dynasty' ? 'stash' : (starterGain ?? 0) > 0
      ? currentStarter && currentSignal?.weeks.find(w => w.week === week)?.bye ? 'bye-cover'
        : currentStarter && unavailable(status(currentStarter, currentSignal)) ? 'injury-cover' : 'starter-upgrade'
      : 'bench-depth';
    const uncertainty: string[] = [];
    if (!s.role) uncertainty.push('Role trend unavailable; no usage adjustment applied.');
    else if (s.role.games < 3) uncertainty.push(`Role trend uses only ${s.role.games} game(s).`);
    if (status(add, s) && !['active', 'healthy'].includes((status(add, s) ?? '').toLowerCase())) uncertainty.push(`Availability: ${status(add, s)}. Future recovery is uncertain.`);
    if (!s.weeks.find(w => w.week === week)?.opponent && !s.weeks.find(w => w.week === week)?.bye) uncertainty.push('Upcoming opponent is unknown; no matchup advantage assumed.');
    if (s.weeks.some(w => remainingWeeks.includes(w.week) && w.bye === undefined)) uncertainty.push('Some bye designations are missing; verify the schedule.');
    if (s.weeks.some(w => remainingWeeks.includes(w.week) && !w.bye && w.matchupMultiplier === undefined)) uncertainty.push('Some opponent strength estimates are missing; neutral matchup weights used.');
    if (value(add, 'rest-of-season') === null) uncertainty.push('Rest-of-season projection coverage is incomplete.');
    if (!comparison) uncertainty.push('Starter comparison is incomplete; unknown starter values are not treated as zero.');
    if (horizon === 'dynasty') uncertainty.push('Future-week stat forecasts carry substantial development and role uncertainty.');
    if (!playoffWeeks.length) uncertainty.push('No remaining playoff schedule is configured.');
    const risk = horizon === 'dynasty' || unavailable(status(add, s)) || uncertainty.length >= 3 ? 'high' : uncertainty.length || (status(add, s) ?? '').toLowerCase() === 'questionable' ? 'medium' : 'low';
    const score = round(net + Math.max(0, starterGain ?? 0) * .6 + (need === 'bye-cover' || need === 'injury-cover' ? 2 : 0) - (risk === 'high' ? 2 : risk === 'medium' ? .75 : 0));
    if (score <= 0) continue;
    const urgency = horizon === 'streamer' || need === 'bye-cover' || need === 'injury-cover' ? 'high' : horizon === 'dynasty' ? 'low' : 'medium';
    const baseShare = Math.min(.3, .02 + Math.max(0, score) * .009 + (urgency === 'high' ? .03 : 0));
    const minimum = Math.floor(Math.min(balance ?? 0, (budget ?? balance ?? 0) * baseShare * (risk === 'high' ? .4 : .65)));
    const maximum = Math.ceil(Math.min(balance ?? 0, (budget ?? balance ?? 0) * baseShare * (risk === 'high' ? 1.3 : 1.1)));
    const scoringOf = horizon === 'dynasty' ? scored.byPlayerId.get(add.id)!.dynasty! : explain(add, week);
    const reasons = [
      `Your league's ${report.scoringLabel} scoring applied to the provider's raw stat forecast; ${horizon === 'streamer' ? 'current-week points' : horizon === 'dynasty' ? 'future typical-week points' : 'remaining-week average with 25% weight on the remaining playoff average'}.`,
      `Week ${week}: ${scoringOf.explanation}.`,
      comparison ? `${starterGain! >= 0 ? '+' : ''}${starterGain} points versus ${comparison.player?.fullName ?? 'an empty eligible starter slot'}.` : 'Not enough forecast coverage to compare current starters.',
      weak ? `${benchGain! >= 0 ? '+' : ''}${benchGain} points versus weakest valued bench option ${weak.fullName} for this horizon.` : 'No fully valued, droppable bench baseline.',
      s.role ? `Role share ${Math.round(s.role.previousShare * 100)}% → ${Math.round(s.role.recentShare * 100)}% over ${s.role.games} game(s); weekly forecast adjustment ${round((roleMultiplier(s) - 1) * 100)}%.` : 'Role trend is unknown.',
    ];
    const upcoming = remainingWeeks.slice(0, 3).map(w => ({ week: w, opponent: s.weeks.find(f => f.week === w)?.opponent ?? null, bye: s.weeks.find(f => f.week === w)?.bye ?? false, points: points(add, w) }));
    const playoffPoints = meanFor(add, playoffWeeks);
    if (playoffPoints != null) reasons.push(`Playoff weeks ${playoffWeeks.join(', ')} average ${round(playoffPoints)} points after opponent and bye adjustments.`);
    report.recommendations.push({
      id: `${add.id}:${horizon}`, priority: 0, add: identity(add), drop: drop ? identity(drop) : null, horizon, risk, need, score,
      projectedPoints: round(projected),
      pointsExplanation: `${rules.scoring.describe(round(projected))}${horizon === 'streamer' ? ' this week' : horizon === 'dynasty' ? ' per future typical week' : ' per weighted remaining week'}`,
      contributions: scoringOf.contributions,
      starterGain, benchGain, starterComparison: currentStarter ? identity(currentStarter) : null, weakestBench: weak ? identity(weak) : null,
      dropCost: drop ? round(dropCost) : null,
      dropReason: drop ? `${drop.fullName} is the lowest-retention legal bench drop (${round(dropCost)} points, using the maximum of current, season${rules.format === 'dynasty' ? ' and dynasty' : ''} value).` : 'An active roster slot is open; no drop is required.',
      upcoming, playoffPoints: playoffPoints == null ? null : round(playoffPoints), reasons, uncertainty,
      faab: faabEnabled && balance != null ? { min: minimum, max: maximum, remaining: balance, urgency, explanation: `${urgency} urgency: ${horizon === 'streamer' ? 'a current-week lineup improvement' : need === 'bye-cover' || need === 'injury-cover' ? 'starter availability needs cover' : horizon === 'dynasty' ? 'a longer-term stash can wait' : 'sustained roster value'}. ${risk} risk ${risk === 'high' ? 'widens the range and lowers its floor' : 'informs the range'}. Heuristic share of the ${budget != null ? 'original' : 'remaining'} budget, capped at $${balance} remaining; rival bids and claim deadlines are unknown. ${balance === 0 ? 'Only a $0 bid is affordable; verify that your league permits it.' : 'Choose a bid within the range after reviewing competing needs.'}` } : null,
    });
  }
  report.recommendations.sort((a, b) => b.score - a.score || a.add.id.localeCompare(b.add.id) || horizons.indexOf(a.horizon) - horizons.indexOf(b.horizon));
  report.recommendations.forEach((r, i) => r.priority = i + 1);
  report.status = report.recommendations.length && report.recommendations.every(r => !r.uncertainty.length) && candidates.length === candidatePool.length ? 'ready' : 'partial';
  if (!report.recommendations.length) report.warnings.push('No supported positive-value add/drop pairs were found. Complete forecasts or a safe drop may be missing; holding your roster can be the best option.');
  return report;
}
