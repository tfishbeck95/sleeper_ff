import { scoringFormatLabel, scoringSnapshotId } from '@sleeper/domain';
import type {
  EvaluatedSlot, ExplainableScore, LeagueEvaluation, LeagueFormat, PositionEvaluation, RosterEvaluation,
  RosterRules, ScoredPoints, ScoringConfiguration, TradedDraftPick,
} from '@sleeper/domain';

export type { EvaluatedSlot, ExplainableScore, LeagueEvaluation, PositionEvaluation, RosterEvaluation };

/**
 * A player as lineup evaluation accepts it: league-scored points only.
 *
 * There is no generic `projectedPoints` input. `projected`, `floor` and `ceiling` are produced by
 * applying the synchronized league's scoring rules to a provider's raw statistics (see
 * `projection-scoring.ts`), and `scoringSnapshotId` proves which observation produced them. A
 * player scored under a different snapshot, or not scored at all, cannot be evaluated here.
 */
export interface EvaluationPlayer {
  id: string; name: string; positions: string[];
  projected: ScoredPoints;
  /** Present only when the provider supplied a floor/ceiling raw-stat scenario. Never fabricated. */
  floor: ScoredPoints | null; ceiling: ScoredPoints | null;
  scoringSnapshotId: string; forecastUpdatedAt: string;
  age?: number; byeWeek?: number; injuryStatus?: string | null;
}
export interface EvaluationRoster {
  rosterId: number; name: string; playerIds: string[];
  reserveIds?: string[]; taxiIds?: string[];
}
export interface EvaluationInput {
  scoring?: ScoringConfiguration;
  rules: RosterRules; format: LeagueFormat; week: number;
  rosters: EvaluationRoster[]; players: EvaluationPlayer[];
  tradedPicks?: TradedDraftPick[]; currentSeason?: string;
}

interface Assigned { player: EvaluationPlayer; slot: string; }
const round = (value: number) => Math.round(value * 10) / 10;
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const available = (player: EvaluationPlayer) => !['Out', 'IR', 'PUP', 'Suspended'].includes(player.injuryStatus ?? '');
const points = (player: EvaluationPlayer) => player.projected.points;

/** Evaluates every roster with league-relative baselines; every numeric result carries its rationale. */
export class LeagueEvaluationService {
  evaluate(input: EvaluationInput): LeagueEvaluation {
    if (input.scoring?.kind !== 'complete-live') throw new Error('Lineup evaluation unavailable: validated complete live scoring is required.');
    const snapshotId = scoringSnapshotId(input.scoring);
    const label = scoringFormatLabel(input.scoring);
    // Only points this league produced may rank this league. A foreign or absent snapshot fails closed.
    for (const player of input.players) {
      if (player.scoringSnapshotId !== snapshotId) throw new Error(`Lineup evaluation unavailable: ${player.name} carries points from scoring snapshot ${player.scoringSnapshotId}, not this league's ${snapshotId}.`);
      if (!Number.isFinite(Date.parse(player.forecastUpdatedAt))) throw new Error(`Lineup evaluation unavailable: ${player.name} has no valid forecast timestamp.`);
      if (!Number.isFinite(player.projected.points)) throw new Error(`Lineup evaluation unavailable: ${player.name} has a nonfinite league-scored projection.`);
    }
    const forecastUpdatedAt = input.players.map(player => player.forecastUpdatedAt).sort()[0] ?? '';
    const players = new Map(input.players.map(player => [player.id, player]));
    const assignments = new Map<number, Assigned[]>();
    for (const roster of input.rosters) assignments.set(roster.rosterId, this.assign(roster.playerIds.map(id => players.get(id)).filter((v): v is EvaluationPlayer => Boolean(v)), input.rules));

    const basePositions = [...new Set(input.rules.starters.flatMap(slot => input.rules.eligiblePositions(slot.position)).filter(position => !position.includes('FLEX')))];
    const replacementLevels = Object.fromEntries(basePositions.map(position => {
      const demand = Math.max(1, input.rosters.length * input.rules.starters.filter(slot => input.rules.eligiblePositions(slot.position).includes(position)).length);
      const pool = input.players.filter(player => player.positions.includes(position)).sort((a, b) => points(b) - points(a));
      const score = round(pool[Math.min(demand, Math.max(0, pool.length - 1))] ? points(pool[Math.min(demand, Math.max(0, pool.length - 1))]!) : 0);
      return [position, { score, explanation: `${position} replacement level is the first player beyond ${demand} league-wide demanded starter slot(s), scoring ${score} points under your league's ${label} scoring.` }];
    }));

    const preliminary = input.rosters.map(roster => this.roster(input, label, roster, players, assignments.get(roster.rosterId) ?? [], replacementLevels));
    const metrics = ['QB', 'RB', 'WR', 'TE'].map(position => ({ position, values: preliminary.map(r => r.positions.find(p => p.position === position)?.starters.score ?? 0) }));
    for (const roster of preliminary) {
      for (const metric of metrics) {
        const own = roster.positions.find(value => value.position === metric.position)?.starters.score ?? 0;
        const leagueAverage = average(metric.values);
        if (own > leagueAverage + 0.5) roster.relativeStrengths.push(`${metric.position} starters score ${round(own - leagueAverage)} points above the league average under your league's ${label} scoring.`);
        if (own < leagueAverage - 0.5) roster.relativeWeaknesses.push(`${metric.position} starters score ${round(leagueAverage - own)} points below the league average under your league's ${label} scoring.`);
      }
      const weeklyAverage = average(preliminary.map(value => value.projectedWeekly.score));
      if (roster.projectedWeekly.score >= weeklyAverage) roster.relativeStrengths.unshift(`The starting lineup scores ${round(roster.projectedWeekly.score - weeklyAverage)} points above the league average.`);
      else roster.relativeWeaknesses.unshift(`The starting lineup scores ${round(weeklyAverage - roster.projectedWeekly.score)} points below the league average.`);
      if (!roster.relativeStrengths.length) roster.relativeStrengths.push('No position currently grades materially above the league baseline.');
      if (!roster.relativeWeaknesses.length) roster.relativeWeaknesses.push('No position currently grades materially below the league baseline.');
    }
    return { rosters: preliminary, replacementLevels, scoringSnapshotId: snapshotId, scoringLabel: label, forecastUpdatedAt };
  }

  private assign(pool: EvaluationPlayer[], rules: RosterRules): Assigned[] {
    const remaining = [...pool].sort((a, b) => points(b) - points(a));
    const slots = [...rules.starters].sort((a, b) => rules.eligiblePositions(a.position).length - rules.eligiblePositions(b.position).length);
    return slots.flatMap(slot => {
      const index = remaining.findIndex(player => player.positions.some(position => rules.eligiblePositions(slot.position).includes(position)));
      return index < 0 ? [] : [{ player: remaining.splice(index, 1)[0]!, slot: slot.position }];
    });
  }

  private roster(input: EvaluationInput, label: string, roster: EvaluationRoster, players: Map<string, EvaluationPlayer>, starters: Assigned[], replacements: Record<string, ExplainableScore>): RosterEvaluation {
    const all = roster.playerIds.map(id => players.get(id)).filter((v): v is EvaluationPlayer => Boolean(v));
    const starterIds = new Set(starters.map(value => value.player.id)); const bench = all.filter(player => !starterIds.has(player.id));
    const total = starters.reduce((sum, value) => sum + points(value.player), 0);
    // Floor and ceiling exist only where the provider supplied a raw-stat scenario; nothing is invented.
    const withoutScenarios = starters.filter(value => !value.player.floor || !value.player.ceiling).map(value => value.player.name);
    const floor = withoutScenarios.length ? null : starters.reduce((sum, value) => sum + value.player.floor!.points, 0);
    const ceiling = withoutScenarios.length ? null : starters.reduce((sum, value) => sum + value.player.ceiling!.points, 0);
    const bye = starters.filter(value => value.player.byeWeek === input.week);
    const injured = starters.filter(value => !available(value.player));
    const upgrades = bench.filter(player => starters.some(starter => player.positions.some(position => input.rules.eligiblePositions(starter.slot).includes(position)) && points(player) > points(starter.player)));
    const expendable = bench.filter(player => points(player) <= Math.max(...player.positions.map(position => replacements[position]?.score ?? 0), 0));
    const positions = [...new Set(all.flatMap(player => player.positions))].sort().map((position): PositionEvaluation => {
      const atPosition = starters.filter(value => value.player.positions.includes(position)); const reserves = bench.filter(value => value.positions.includes(position));
      const starterPoints = atPosition.reduce((sum, value) => sum + points(value.player), 0); const benchPoints = reserves.reduce((sum, value) => sum + points(value), 0);
      const replacement = replacements[position]?.score ?? 0; const vor = atPosition.reduce((sum, value) => sum + Math.max(0, points(value.player) - replacement), 0);
      return { position,
        starters: { score: round(starterPoints), explanation: `${atPosition.length} assigned ${position} starter(s) combine for ${round(starterPoints)} points under your league's ${label} scoring.` },
        bench: { score: round(benchPoints), explanation: `${reserves.length} bench-eligible ${position} player(s) combine for ${round(benchPoints)} points under your league's ${label} scoring.` },
        scarcity: { score: round(vor), explanation: `Starter value is ${round(vor)} points above the league replacement level of ${replacement} at ${position}.` },
      };
    });
    const ages = all.filter(player => player.age != null).map(player => player.age!); const targetAge = average(all.flatMap(player => player.positions.includes('QB') || player.positions.includes('TE') ? [29] : [26]));
    const picks = (input.tradedPicks ?? []).filter(pick => pick.ownerId === roster.rosterId);
    const pickValue = picks.reduce((sum, pick) => sum + Math.max(1, 5 - pick.round), 0);
    const unplaced = [...starters];
    const lineup: EvaluatedSlot[] = input.rules.starters.map(slot => {
      const index = unplaced.findIndex(value => value.slot === slot.position);
      const assigned = index < 0 ? undefined : unplaced.splice(index, 1)[0];
      return { slot: slot.position, playerId: assigned?.player.id ?? null, name: assigned?.player.name ?? 'Empty slot', points: assigned ? round(points(assigned.player)) : 0 };
    });
    return {
      rosterId: roster.rosterId, rosterName: roster.name,
      projectedWeekly: { score: round(total), explanation: `${starters.length} optimal eligible starters score ${round(total)} points under your league's ${label} scoring and lineup rules.` },
      range: floor == null || ceiling == null
        ? { score: 0, explanation: `No floor/ceiling range: ${withoutScenarios.join(', ')} have no league-scored floor and ceiling scenario from the forecast source, and a range is never estimated from the mean.` }
        : { score: round(ceiling - floor), explanation: `Scoring the supplied floor and ceiling stat scenarios under your league's ${label} rules gives a ${round(floor)}-to-${round(ceiling)} range, a ${round(ceiling - floor)}-point spread.` },
      byeExposure: { score: bye.length, explanation: bye.length ? `${bye.map(v => v.player.name).join(', ')} are projected starters on bye in week ${input.week}.` : `No projected starter is on bye in week ${input.week}.` },
      injuryExposure: { score: injured.length, explanation: injured.length ? `${injured.map(v => `${v.player.name} (${v.player.injuryStatus})`).join(', ')} are unavailable projected starters.` : 'No projected starter has an unavailable injury designation.' },
      benchUtilization: { score: upgrades.length, explanation: upgrades.length ? `${upgrades.map(v => v.name).join(', ')} score above at least one eligible starter under your league's ${label} scoring and may be underutilized.` : 'No bench player scores above an eligible starter.' },
      expendableDepth: { score: expendable.length, explanation: `${expendable.length} bench player(s) score at or below league replacement level: ${expendable.map(v => v.name).join(', ') || 'none'}.` },
      dynastyAgeCurve: input.format === 'dynasty' ? { score: round(average(ages)), explanation: ages.length ? `Known roster ages average ${round(average(ages))}; the position-adjusted competitive-age reference is ${round(targetAge)}.` : 'No player ages were supplied, so the dynasty age curve cannot be quantified.' } : null,
      futurePickCapital: input.format === 'dynasty' ? { score: pickValue, explanation: `${picks.length} currently owned traded/future pick(s) contribute ${pickValue} capital units (earlier rounds weighted more heavily).` } : null,
      positions, lineup,
      floorPoints: floor == null ? null : round(floor), ceilingPoints: ceiling == null ? null : round(ceiling),
      relativeStrengths: [], relativeWeaknesses: [],
    };
  }
}
