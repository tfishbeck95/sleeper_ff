import type { LeagueFormat, RosterRules, TradedDraftPick } from '@sleeper/domain';

export interface EvaluationPlayer {
  id: string; name: string; positions: string[];
  projectedPoints: number; floor?: number; ceiling?: number;
  age?: number; byeWeek?: number; injuryStatus?: string | null;
}
export interface EvaluationRoster {
  rosterId: number; name: string; playerIds: string[];
  reserveIds?: string[]; taxiIds?: string[];
}
export interface ExplainableScore { score: number; explanation: string; }
export interface PositionEvaluation { position: string; starters: ExplainableScore; bench: ExplainableScore; scarcity: ExplainableScore; }
export interface RosterEvaluation {
  rosterId: number; rosterName: string;
  projectedWeekly: ExplainableScore; range: ExplainableScore;
  byeExposure: ExplainableScore; injuryExposure: ExplainableScore;
  benchUtilization: ExplainableScore; expendableDepth: ExplainableScore;
  dynastyAgeCurve: ExplainableScore | null; futurePickCapital: ExplainableScore | null;
  positions: PositionEvaluation[];
  relativeStrengths: string[]; relativeWeaknesses: string[];
}
export interface LeagueEvaluation { rosters: RosterEvaluation[]; replacementLevels: Record<string, ExplainableScore>; }
export interface EvaluationInput {
  rules: RosterRules; format: LeagueFormat; week: number;
  rosters: EvaluationRoster[]; players: EvaluationPlayer[];
  tradedPicks?: TradedDraftPick[]; currentSeason?: string;
}

interface Assigned { player: EvaluationPlayer; slot: string; }
const round = (value: number) => Math.round(value * 10) / 10;
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const available = (player: EvaluationPlayer) => !['Out', 'IR', 'PUP', 'Suspended'].includes(player.injuryStatus ?? '');

/** Evaluates every roster with league-relative baselines; every numeric result carries its rationale. */
export class LeagueEvaluationService {
  evaluate(input: EvaluationInput): LeagueEvaluation {
    const players = new Map(input.players.map(player => [player.id, player]));
    const assignments = new Map<number, Assigned[]>();
    for (const roster of input.rosters) assignments.set(roster.rosterId, this.assign(roster.playerIds.map(id => players.get(id)).filter((v): v is EvaluationPlayer => Boolean(v)), input.rules));

    const basePositions = [...new Set(input.rules.starters.flatMap(slot => input.rules.eligiblePositions(slot.position)).filter(position => !position.includes('FLEX')))];
    const replacementLevels = Object.fromEntries(basePositions.map(position => {
      const demand = Math.max(1, input.rosters.length * input.rules.starters.filter(slot => input.rules.eligiblePositions(slot.position).includes(position)).length);
      const pool = input.players.filter(player => player.positions.includes(position)).sort((a, b) => b.projectedPoints - a.projectedPoints);
      const score = round(pool[Math.min(demand, Math.max(0, pool.length - 1))]?.projectedPoints ?? 0);
      return [position, { score, explanation: `${position} replacement level is the first player beyond ${demand} league-wide demanded starter slot(s), projecting ${score} points.` }];
    }));

    const preliminary = input.rosters.map(roster => this.roster(input, roster, players, assignments.get(roster.rosterId) ?? [], replacementLevels));
    const metrics = ['QB', 'RB', 'WR', 'TE'].map(position => ({ position, values: preliminary.map(r => r.positions.find(p => p.position === position)?.starters.score ?? 0) }));
    for (const roster of preliminary) {
      for (const metric of metrics) {
        const own = roster.positions.find(value => value.position === metric.position)?.starters.score ?? 0;
        const leagueAverage = average(metric.values);
        if (own > leagueAverage + 0.5) roster.relativeStrengths.push(`${metric.position} starters project ${round(own - leagueAverage)} points above the league average.`);
        if (own < leagueAverage - 0.5) roster.relativeWeaknesses.push(`${metric.position} starters project ${round(leagueAverage - own)} points below the league average.`);
      }
      const weeklyAverage = average(preliminary.map(value => value.projectedWeekly.score));
      if (roster.projectedWeekly.score >= weeklyAverage) roster.relativeStrengths.unshift(`The starting lineup projects ${round(roster.projectedWeekly.score - weeklyAverage)} points above the league average.`);
      else roster.relativeWeaknesses.unshift(`The starting lineup projects ${round(weeklyAverage - roster.projectedWeekly.score)} points below the league average.`);
      if (!roster.relativeStrengths.length) roster.relativeStrengths.push('No position currently grades materially above the league baseline.');
      if (!roster.relativeWeaknesses.length) roster.relativeWeaknesses.push('No position currently grades materially below the league baseline.');
    }
    return { rosters: preliminary, replacementLevels };
  }

  private assign(pool: EvaluationPlayer[], rules: RosterRules): Assigned[] {
    const remaining = [...pool].sort((a, b) => b.projectedPoints - a.projectedPoints);
    const slots = [...rules.starters].sort((a, b) => rules.eligiblePositions(a.position).length - rules.eligiblePositions(b.position).length);
    return slots.flatMap(slot => {
      const index = remaining.findIndex(player => player.positions.some(position => rules.eligiblePositions(slot.position).includes(position)));
      return index < 0 ? [] : [{ player: remaining.splice(index, 1)[0]!, slot: slot.position }];
    });
  }

  private roster(input: EvaluationInput, roster: EvaluationRoster, players: Map<string, EvaluationPlayer>, starters: Assigned[], replacements: Record<string, ExplainableScore>): RosterEvaluation {
    const all = roster.playerIds.map(id => players.get(id)).filter((v): v is EvaluationPlayer => Boolean(v));
    const starterIds = new Set(starters.map(value => value.player.id)); const bench = all.filter(player => !starterIds.has(player.id));
    const total = starters.reduce((sum, value) => sum + value.player.projectedPoints, 0);
    const floor = starters.reduce((sum, value) => sum + (value.player.floor ?? value.player.projectedPoints * .75), 0);
    const ceiling = starters.reduce((sum, value) => sum + (value.player.ceiling ?? value.player.projectedPoints * 1.3), 0);
    const bye = starters.filter(value => value.player.byeWeek === input.week);
    const injured = starters.filter(value => !available(value.player));
    const upgrades = bench.filter(player => starters.some(starter => player.positions.some(position => input.rules.eligiblePositions(starter.slot).includes(position)) && player.projectedPoints > starter.player.projectedPoints));
    const expendable = bench.filter(player => player.projectedPoints <= Math.max(...player.positions.map(position => replacements[position]?.score ?? 0), 0));
    const positions = [...new Set(all.flatMap(player => player.positions))].sort().map(position => {
      const atPosition = starters.filter(value => value.player.positions.includes(position)); const reserves = bench.filter(value => value.positions.includes(position));
      const starterPoints = atPosition.reduce((sum, value) => sum + value.player.projectedPoints, 0); const benchPoints = reserves.reduce((sum, value) => sum + value.projectedPoints, 0);
      const replacement = replacements[position]?.score ?? 0; const vor = atPosition.reduce((sum, value) => sum + Math.max(0, value.player.projectedPoints - replacement), 0);
      return { position,
        starters: { score: round(starterPoints), explanation: `${atPosition.length} assigned ${position} starter(s) combine for ${round(starterPoints)} projected points.` },
        bench: { score: round(benchPoints), explanation: `${reserves.length} bench-eligible ${position} player(s) combine for ${round(benchPoints)} projected points.` },
        scarcity: { score: round(vor), explanation: `Starter value is ${round(vor)} points above the league replacement level of ${replacement} at ${position}.` },
      };
    });
    const ages = all.filter(player => player.age != null).map(player => player.age!); const targetAge = average(all.flatMap(player => player.positions.includes('QB') || player.positions.includes('TE') ? [29] : [26]));
    const picks = (input.tradedPicks ?? []).filter(pick => pick.ownerId === roster.rosterId);
    const pickValue = picks.reduce((sum, pick) => sum + Math.max(1, 5 - pick.round), 0);
    return {
      rosterId: roster.rosterId, rosterName: roster.name,
      projectedWeekly: { score: round(total), explanation: `${starters.length} optimal eligible starters project for ${round(total)} points under this league's lineup rules.` },
      range: { score: round(ceiling - floor), explanation: `The lineup projects a ${round(floor)}-to-${round(ceiling)} floor/ceiling range, a ${round(ceiling - floor)}-point spread.` },
      byeExposure: { score: bye.length, explanation: bye.length ? `${bye.map(v => v.player.name).join(', ')} are projected starters on bye in week ${input.week}.` : `No projected starter is on bye in week ${input.week}.` },
      injuryExposure: { score: injured.length, explanation: injured.length ? `${injured.map(v => `${v.player.name} (${v.player.injuryStatus})`).join(', ')} are unavailable projected starters.` : 'No projected starter has an unavailable injury designation.' },
      benchUtilization: { score: upgrades.length, explanation: upgrades.length ? `${upgrades.map(v => v.name).join(', ')} project above at least one eligible starter and may be underutilized.` : 'No bench player projects above an eligible starter.' },
      expendableDepth: { score: expendable.length, explanation: `${expendable.length} bench player(s) project at or below league replacement level: ${expendable.map(v => v.name).join(', ') || 'none'}.` },
      dynastyAgeCurve: input.format === 'dynasty' ? { score: round(average(ages)), explanation: ages.length ? `Known roster ages average ${round(average(ages))}; the position-adjusted competitive-age reference is ${round(targetAge)}.` : 'No player ages were supplied, so the dynasty age curve cannot be quantified.' } : null,
      futurePickCapital: input.format === 'dynasty' ? { score: pickValue, explanation: `${picks.length} currently owned traded/future pick(s) contribute ${pickValue} capital units (earlier rounds weighted more heavily).` } : null,
      positions, relativeStrengths: [], relativeWeaknesses: [],
    };
  }
}
