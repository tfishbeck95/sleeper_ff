import { interpretLeagueRules, scoringFormatLabel } from '@sleeper/domain';
import type {
  ExplainableScore, League, LineupMatchup, LineupPlayerView, LineupReport, Matchup, NflPlayer, Roster,
  ScoredPoints, StartSitDecision, TradedDraftPick, User, WeekOutlook,
} from '@sleeper/domain';
import { LeagueEvaluationService, type EvaluationPlayer } from './evaluation.js';
import { scoreLeagueForecasts, weekPoints, type ScoredPlayer } from './projection-scoring.js';
import type { WaiverSignals } from './waiver-signals.js';

export interface LineupInput {
  league: League; rosters: Roster[]; players: NflPlayer[]; users?: User[];
  matchups?: Matchup[]; tradedPicks?: TradedDraftPick[];
  rosterId: number; week: number; signals: WaiverSignals | null; now?: Date;
}

const round = (value: number) => Math.round(value * 10) / 10;
const allIds = (roster: Roster) => [...new Set([...roster.playerIds, ...roster.starterIds, ...roster.reserveIds, ...roster.taxiIds].filter(id => id && id !== '0'))];
const positionsOf = (player: NflPlayer) => player.fantasyPositions.length ? player.fantasyPositions : player.position ? [player.position] : [];
/** A healthy player has no designation: "Active" is a roster status, not something to warn about. */
const designation = (status: string | null) => status && !['active', 'healthy'].includes(status.toLowerCase()) ? status : null;
/** Abramowitz-Stegun 7.1.26. A normal approximation, disclosed as such wherever it is used. */
const erf = (x: number) => {
  const t = 1 / (1 + .3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const normalCdf = (z: number) => .5 * (1 + erf(z / Math.SQRT2));
/** Treats a supplied floor/ceiling scenario band as roughly a 10th-to-90th percentile interval. */
const SCENARIO_BAND_SIGMAS = 2.563;
/** A target-stability gap this wide or wider is worth warning about before a lineup change. */
const STABILITY_TOLERANCE = .15;

/**
 * Lineup analysis for one owner.
 *
 * Nothing here accepts a provider's fantasy points. Raw stat forecasts and their optional floor and
 * ceiling scenarios are scored once, by this league's validated rules, in `scoreLeagueForecasts`;
 * only those league-scored values reach lineup assignment, replacement levels, start/sit,
 * matchup totals, win probability, roster strength, and the bye and playoff outlooks.
 */
export function analyzeLineup(input: LineupInput): LineupReport {
  const { league, week } = input;
  const now = input.now ?? new Date();
  const rules = interpretLeagueRules(league);
  const rosters = input.rosters.filter(r => r.leagueId === league.id);
  const roster = rosters.find(r => r.rosterId === input.rosterId);
  if (!roster) throw new Error('Selected roster does not belong to this league.');
  const report: LineupReport = {
    leagueId: league.id, rosterId: input.rosterId, week, season: league.season, generatedAt: now.toISOString(),
    status: 'unavailable', scoring: rules.scoring.configuration, scoringSnapshotId: rules.scoring.snapshotId,
    scoringLabel: scoringFormatLabel(rules.scoring.configuration), forecast: null,
    warnings: [], rejected: [], lineup: [], optimal: [], bench: [], startSit: [], matchup: null,
    rosterStrength: [], replacementLevels: {}, byeOutlook: [], playoffOutlook: null,
    methodology: 'Forecast providers supply raw projected statistics and optional floor/ceiling stat scenarios. This league’s validated scoring rules convert each of them to points exactly once; no generic projected-points value is accepted. Win probability is a normal approximation over the supplied scenario band, not a calibrated forecast.',
  };
  if (!rules.scoring.actionable) {
    report.warnings.push('Validated complete live scoring is required. Lineup, waiver and trade rankings are unavailable.', ...rules.scoring.configuration.issues.map(issue => issue.message));
    return report;
  }
  if (league.totalRosters != null && rosters.length !== league.totalRosters) {
    report.warnings.push('League roster coverage is incomplete, so league-relative baselines and replacement levels cannot be computed.'); return report;
  }
  const signals = input.signals;
  if (!signals || signals.season !== league.season || signals.week !== week) {
    report.warnings.push('No forecast source is configured for this season and week. Raw stat forecasts are required; no generic projection is substituted.'); return report;
  }
  report.forecast = { source: signals.source, updatedAt: signals.updatedAt };
  const age = now.getTime() - Date.parse(signals.updatedAt);
  if (!Number.isFinite(age) || age > 48 * 60 * 60_000 || age < -5 * 60_000) {
    report.warnings.push('Forecast source is stale (over 48 hours) or has an invalid future timestamp. Refresh it before using lineup analysis.'); return report;
  }

  // The input boundary: raw statistics in, league-scored points with provenance out.
  const scored = scoreLeagueForecasts({
    rules: rules.scoring, signals, players: input.players, requiredWeeks: [week],
    availability: { policy: 'selected-week', selectedWeek: week }, scoredAt: now,
  });
  report.rejected = scored.rejected;
  if (scored.rejected.length) report.warnings.push(`${scored.rejected.length} projection(s) were refused and excluded rather than treated as authoritative. They are listed with their reasons and were never scored as zero.`);

  const seasonEnd = rules.playoffs.startsWeek == null ? 18 : Math.min(18, rules.playoffs.startsWeek + (rules.playoffs.rounds ?? 1) - 1 + Number(rules.playoffs.twoWeekChampionship));
  const remainingWeeks = Array.from({ length: Math.max(0, seasonEnd - week + 1) }, (_, index) => week + index);
  const playoffWeeks = rules.playoffs.startsWeek == null ? [] : remainingWeeks.filter(value => value >= rules.playoffs.startsWeek!);
  const selected = (player: ScoredPlayer) => player.weeks.find(value => value.week === week)!;
  const view = (player: ScoredPlayer): LineupPlayerView => {
    const current = selected(player);
    return {
      playerId: player.playerId, name: player.name, positions: player.positions, team: player.team,
      scored: weekPoints(rules.scoring, current),
      floorPoints: current.floorPoints == null ? null : round(current.floorPoints),
      ceilingPoints: current.ceilingPoints == null ? null : round(current.ceilingPoints),
      bye: current.bye, injuryStatus: designation(player.injuryStatus), opportunity: player.opportunity,
    };
  };
  const evaluationPlayer = (player: ScoredPlayer): EvaluationPlayer => {
    const current = selected(player);
    const scaled = (value: ScoredPoints | null): ScoredPoints | null => value == null ? null
      : { ...value, points: Math.round(value.points * current.multiplier * 100) / 100, explanation: rules.scoring.describe(Math.round(value.points * current.multiplier * 100) / 100) };
    return {
      id: player.playerId, name: player.name, positions: player.positions,
      projected: weekPoints(rules.scoring, current), floor: scaled(current.floor), ceiling: scaled(current.ceiling),
      scoringSnapshotId: player.scoringSnapshotId, forecastUpdatedAt: player.forecastUpdatedAt,
      age: player.age ?? undefined, byeWeek: current.bye ? week : undefined, injuryStatus: designation(player.injuryStatus),
    };
  };
  const rosteredIds = new Set(rosters.flatMap(allIds));
  const evaluated = scored.players.filter(player => rosteredIds.has(player.playerId));
  const unscored = [...rosteredIds].filter(id => !scored.byPlayerId.has(id));
  if (unscored.length) report.warnings.push(`${unscored.length} rostered player(s) have no league-scored forecast and are excluded from every total: ${unscored.map(id => input.players.find(p => p.id === id)?.fullName ?? id).join(', ')}.`);

  const teamName = (value: Roster) => input.users?.find(user => user.id === value.ownerId)?.displayName ?? `Roster ${value.rosterId}`;
  const evaluation = new LeagueEvaluationService().evaluate({
    scoring: rules.scoring.configuration, rules: rules.roster, format: rules.format, week,
    rosters: rosters.map(value => ({ rosterId: value.rosterId, name: teamName(value), playerIds: allIds(value).filter(id => !value.reserveIds.includes(id) && !value.taxiIds.includes(id)), reserveIds: value.reserveIds, taxiIds: value.taxiIds })),
    players: evaluated.map(evaluationPlayer), tradedPicks: input.tradedPicks, currentSeason: league.season,
  });
  report.rosterStrength = evaluation.rosters;
  report.replacementLevels = evaluation.replacementLevels;

  const own = evaluation.rosters.find(value => value.rosterId === roster.rosterId)!;
  const byId = new Map(evaluated.map(player => [player.playerId, player]));
  const slotView = (slotName: string, id: string | null) => ({
    slot: slotName,
    player: id && byId.has(id) ? view(byId.get(id)!) : null,
    explanation: id && byId.has(id)
      ? `${byId.get(id)!.name} fills ${slotName} with ${weekPoints(rules.scoring, selected(byId.get(id)!)).explanation}.`
      : id ? `The player in ${slotName} has no validated, league-scored forecast, so this slot contributes nothing to any total.`
        : `No player is assigned to ${slotName}. An empty slot scores nothing.`,
  });
  // What the manager has actually submitted in Sleeper, scored under this league's rules.
  report.lineup = rules.roster.starters.map((slot, index) => {
    const id = roster.starterIds[index];
    return slotView(slot.position, id && id !== '0' ? id : null);
  });
  report.optimal = own.lineup.map(slot => slotView(slot.slot, slot.playerId));
  const startingIds = new Set(report.lineup.flatMap(slot => slot.player ? [slot.player.playerId] : []));
  const activeIds = new Set(allIds(roster).filter(id => !roster.reserveIds.includes(id) && !roster.taxiIds.includes(id)));
  report.bench = evaluated.filter(player => activeIds.has(player.playerId) && !startingIds.has(player.playerId)).sort((a, b) => selected(b).points - selected(a).points).map(view);

  // Start/sit compares the submitted lineup with eligible bench players, all on league-scored points.
  const decisions: StartSitDecision[] = [];
  const claimed = new Set<string>();
  for (const slot of report.lineup) {
    const eligible = rules.roster.eligiblePositions(slot.slot);
    const starter = slot.player ? byId.get(slot.player.playerId) : undefined;
    const starterPoints = starter ? selected(starter).points : 0;
    const challenger = evaluated
      .filter(player => activeIds.has(player.playerId) && !startingIds.has(player.playerId) && !claimed.has(player.playerId) && player.positions.some(position => eligible.includes(position)))
      .sort((a, b) => selected(b).points - selected(a).points || a.playerId.localeCompare(b.playerId))[0];
    if (!challenger || selected(challenger).points <= starterPoints + .05) continue;
    claimed.add(challenger.playerId);
    const advantage = round(selected(challenger).points - starterPoints);
    const cautions = ['Confirm both players are unlocked and eligible for this slot in Sleeper before changing anything.'];
    if (selected(challenger).bye) cautions.push(`${challenger.name} is on bye this week.`);
    const flagged = designation(challenger.injuryStatus);
    if (flagged) cautions.push(`${challenger.name} carries the availability designation "${flagged}".`);
    if (!selected(challenger).floor || (starter && !selected(starter).floor)) cautions.push('No floor/ceiling scenario was supplied for both players, so the downside of this swap is unquantified.');
    // A lineup is a safety decision: swapping toward a less consistent target share is worth naming.
    const gaining = challenger.opportunity, losing = starter?.opportunity;
    const lessStable = gaining?.stability != null && losing?.stability != null && losing.stability - gaining.stability >= STABILITY_TOLERANCE;
    if (lessStable) cautions.push(`${challenger.name} has the less stable target share (${gaining!.stability} against ${losing!.stability}). The extra ${advantage} points come with a wider week-to-week range.`);
    if (gaining?.archetype === 'touchdown-dependent' && losing?.archetype === 'volume-driven') cautions.push(`${challenger.name} is touchdown-dependent while ${starter!.name} is volume-driven, so this swap trades a repeatable floor for a less certain outcome.`);
    const role = gaining?.stability != null
      ? ` ${challenger.name} has a ${gaining.stability} target-stability score${gaining.targets != null ? ` on ${gaining.targets} projected targets` : ''}${losing?.stability != null ? ` against ${starter!.name}'s ${losing.stability}` : ''}.`
      : '';
    decisions.push({
      id: `${slot.slot}:${challenger.playerId}`, slot: slot.slot, start: view(challenger),
      sit: starter ? view(starter) : { playerId: '', name: 'Empty slot', positions: [], team: null, scored: { points: 0, explanation: `0.0 points under your league's ${report.scoringLabel} scoring`, breakdown: 'No player is assigned to this slot.', contributions: [] }, floorPoints: null, ceilingPoints: null, bye: false, injuryStatus: null, opportunity: null },
      advantage,
      explanation: `${challenger.name} scores ${weekPoints(rules.scoring, selected(challenger)).explanation}, ${advantage} more than ${starter ? `${starter.name}'s ${round(starterPoints)}` : 'an empty slot'} in ${slot.slot}.${role}`,
      confidence: cautions.length > 1 ? 'low' : advantage >= 3 ? 'high' : 'medium',
      cautions,
    });
  }
  // Ties on points go to the steadier target share: a safe lineup prefers the more repeatable role.
  report.startSit = decisions.sort((a, b) => b.advantage - a.advantage
    || (b.start.opportunity?.stability ?? -1) - (a.start.opportunity?.stability ?? -1)
    || a.id.localeCompare(b.id));

  const submittedTotal = (value: Roster) => {
    const starters = rules.roster.starters.map((_, index) => value.starterIds[index]).map(id => id && id !== '0' ? scored.byPlayerId.get(id) : undefined);
    const filled = starters.filter((player): player is ScoredPlayer => Boolean(player));
    const scenarios = filled.every(player => selected(player).floorPoints != null && selected(player).ceilingPoints != null);
    const total = (pick: (player: ScoredPlayer) => number) => Math.round(filled.reduce((sum, player) => sum + pick(player), 0) * 10) / 10;
    return {
      points: total(player => selected(player).points),
      floor: scenarios ? total(player => selected(player).floorPoints!) : null,
      ceiling: scenarios ? total(player => selected(player).ceilingPoints!) : null,
      empty: starters.length - filled.length,
    };
  };
  report.matchup = buildMatchup(input, report, roster, rosters, submittedTotal, teamName);
  report.byeOutlook = remainingWeeks.map(value => outlookFor(value, playoffWeeks.includes(value), roster, evaluated, rules, report.scoringLabel, activeIds));
  report.playoffOutlook = playoffWeeks.length ? playoffOutlook(playoffWeeks, report.byeOutlook, report.scoringLabel) : null;

  report.warnings.push('Every point on this page is your league’s scoring applied to a provider’s raw statistics. Lineup changes are still confirmed by you in Sleeper.');
  report.status = report.rejected.length || unscored.length ? 'partial' : 'ready';
  return report;
}

interface SubmittedTotal { points: number; floor: number | null; ceiling: number | null; empty: number }

function buildMatchup(
  input: LineupInput, report: LineupReport, roster: Roster, rosters: Roster[],
  submittedTotal: (roster: Roster) => SubmittedTotal, teamName: (roster: Roster) => string,
): LineupMatchup | null {
  const own = submittedTotal(roster);
  const describe = (total: SubmittedTotal, who: string) => ({
    score: total.points,
    explanation: `${who} submitted lineup scores ${total.points} points: this league's ${report.scoringLabel} rules applied to each starter's raw stat forecast${total.empty ? `, with ${total.empty} slot(s) empty or unforecast and therefore contributing nothing` : ''}.`,
  });
  const mine = (input.matchups ?? []).find(value => value.rosterId === report.rosterId && value.week === report.week);
  const other = mine?.matchupId == null ? undefined : (input.matchups ?? []).find(value => value.week === report.week && value.matchupId === mine.matchupId && value.rosterId !== report.rosterId);
  const opponentRoster = other && rosters.find(value => value.rosterId === other.rosterId);
  if (!opponentRoster) return {
    opponentRosterId: null, opponentName: 'No scheduled opponent',
    projectedFor: describe(own, 'Your'),
    projectedAgainst: { score: 0, explanation: 'No opponent matchup was synchronized for this week, so no opposing league-scored total exists.' },
    margin: { score: 0, explanation: 'A margin needs both lineups scored under the same league rules.' },
    winProbability: { value: null, explanation: 'Win probability needs a scheduled opponent whose lineup is scored under the same league rules.' },
  };
  const against = submittedTotal(opponentRoster);
  const margin = Math.round((own.points - against.points) * 10) / 10;
  const spread = (total: SubmittedTotal) => total.floor == null || total.ceiling == null ? null : (total.ceiling - total.floor) / SCENARIO_BAND_SIGMAS;
  const mySigma = spread(own), theirSigma = spread(against);
  const combined = mySigma == null || theirSigma == null ? null : Math.hypot(mySigma, theirSigma);
  return {
    opponentRosterId: opponentRoster.rosterId, opponentName: teamName(opponentRoster),
    projectedFor: describe(own, 'Your'), projectedAgainst: describe(against, `${teamName(opponentRoster)}'s`),
    margin: { score: margin, explanation: `Both totals are submitted lineups scored under your league's ${report.scoringLabel} rules: ${own.points} against ${against.points}.` },
    winProbability: combined == null || combined <= 0
      ? { value: null, explanation: 'Win probability is unavailable: it needs league-scored floor and ceiling scenarios for every starter on both lineups, and those raw-stat scenarios were not supplied.' }
      : {
        value: Math.round(normalCdf(margin / combined) * 1000) / 10,
        explanation: `A ${margin}-point league-scored margin against a combined ${Math.round(combined * 10) / 10}-point standard deviation, taking each supplied floor-to-ceiling band as a 10th-to-90th percentile range. A normal approximation over one scenario band, not a calibrated projection.`,
      },
  };
}

function outlookFor(
  week: number, playoff: boolean, roster: Roster, evaluated: ScoredPlayer[],
  rules: ReturnType<typeof interpretLeagueRules>, label: string, activeIds: Set<string>,
): WeekOutlook {
  const active = evaluated.filter(player => activeIds.has(player.playerId));
  const forecasts = new Map(active.map(player => [player.playerId, player.weeks.find(value => value.week === week)]));
  const missing = active.filter(player => !forecasts.get(player.playerId));
  const onBye = active.filter(player => forecasts.get(player.playerId)?.bye);
  // Flex-aware maximum matching: a bye is only a problem when a starting slot cannot be filled.
  const assigned = new Map<string, number>();
  const place = (slotIndex: number, visited: Set<string>): boolean => {
    for (const player of active) {
      const forecast = forecasts.get(player.playerId);
      if (visited.has(player.playerId) || !forecast || forecast.bye) continue;
      if (!player.positions.some(position => rules.roster.eligiblePositions(rules.roster.starters[slotIndex].position).includes(position))) continue;
      visited.add(player.playerId);
      const prior = assigned.get(player.playerId);
      if (prior === undefined || place(prior, visited)) { assigned.set(player.playerId, slotIndex); return true; }
    }
    return false;
  };
  const fillable = rules.roster.starters.reduce((count, _, index) => count + Number(place(index, new Set())), 0);
  const filled = [...assigned.entries()].map(([playerId]) => forecasts.get(playerId)!.points);
  const projected = missing.length ? null : Math.round(filled.reduce((sum, value) => sum + value, 0) * 10) / 10;
  return {
    week, playoff, bye: onBye.length > 0,
    startersOnBye: onBye.map(player => player.name),
    fillableSlots: fillable, requiredSlots: rules.roster.starters.length,
    projected,
    explanation: missing.length
      ? `Week ${week} has no league-scored forecast for ${missing.map(p => p.name).join(', ')}, so no total is shown rather than an understated one. ${fillable}/${rules.roster.starters.length} starting slots are fillable.`
      : `Week ${week}: ${fillable}/${rules.roster.starters.length} starting slots fillable${onBye.length ? ` with ${onBye.map(p => p.name).join(', ')} on bye` : ''}, scoring ${projected} points under your league's ${label} scoring.`,
  };
}

function playoffOutlook(weeks: number[], outlook: WeekOutlook[], label: string) {
  const rows = outlook.filter(value => weeks.includes(value.week));
  const known = rows.filter(value => value.projected != null);
  const projected = known.length === rows.length && rows.length ? Math.round(known.reduce((sum, value) => sum + value.projected!, 0) / known.length * 10) / 10 : null;
  const risks: string[] = [];
  for (const row of rows.filter(value => value.fillableSlots < value.requiredSlots)) risks.push(`Week ${row.week} cannot fill ${row.requiredSlots - row.fillableSlots} starting slot(s) with the current active roster.`);
  for (const row of rows.filter(value => value.startersOnBye.length)) risks.push(`Week ${row.week} byes: ${row.startersOnBye.join(', ')}.`);
  if (known.length !== rows.length) risks.push('Some playoff weeks have incomplete league-scored forecasts, so the average excludes nothing and is simply withheld.');
  return {
    weeks, projected,
    explanation: projected == null
      ? `Playoff weeks ${weeks.join(', ')} lack complete league-scored forecasts, so no average is shown.`
      : `Playoff weeks ${weeks.join(', ')} average ${projected} points under your league's ${label} scoring, using the same raw-stat forecasts and rules as this week.`,
    risks: risks.length ? risks : ['No bye or coverage gap was found in the configured playoff weeks. Availability can still change.'],
  };
}
