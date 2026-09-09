import type { QuarterbackBreakdown, QuarterbackOutlook, QuarterbackRushingSplit, ScoredPoints, ScoredWeek, ScoringContribution, ScoringRules } from '@sleeper/domain';

const componentKeys = { passingTouchdowns: 'pass_td', passingYards: 'pass_yd', interceptions: 'pass_int', rushingYards: 'rush_yd', rushingTouchdowns: 'rush_td' } as const;
const sum = (values: ScoringContribution[]) => values.reduce((total, value) => total + value.points, 0);
const round = (value: number) => Math.round(value * 100) / 100;

/** Attribution only: every component is already part of the score, including optional run subsets. */
export function scoreQuarterback(rules: ScoringRules, stats: Record<string, number>, split?: QuarterbackRushingSplit): ScoredPoints {
  const scored = rules.score(stats);
  const contribution = (stat: string, amount: number): ScoringContribution => {
    const rate = rules.configuration.settings?.[stat] ?? 0;
    return { stat, amount, rate, points: amount * rate };
  };
  const components = Object.fromEntries(Object.entries(componentKeys).map(([key, stat]) => [key, stats[stat] === undefined ? null : contribution(stat, stats[stat])])) as Pick<QuarterbackBreakdown, keyof typeof componentKeys>;
  const subset = (value?: { yards?: number; touchdowns?: number }) => value ? [
    ...(value.yards === undefined ? [] : [contribution('rush_yd', value.yards)]),
    ...(value.touchdowns === undefined ? [] : [contribution('rush_td', value.touchdowns)]),
  ] : null;
  const quarterback = describeQuarterback({
    ...components, designedRuns: subset(split?.designedRuns), scrambles: subset(split?.scrambles),
    otherPoints: sum(scored.contributions.filter(c => !Object.values(componentKeys).some(stat => stat === c.stat))),
    totalPoints: scored.points, rushingPoints: sum(scored.contributions.filter(c => c.stat.startsWith('rush_') || c.stat.startsWith('bonus_rush_'))),
    turnoverPoints: sum(scored.contributions.filter(c => ['pass_int', 'fum_lost'].includes(c.stat))),
    multiplier: 1, explanation: '',
  });
  return { ...scored, quarterback, explanation: `${scored.explanation}. ${quarterback.explanation}` };
}

function describeQuarterback(value: QuarterbackBreakdown): QuarterbackBreakdown {
  const labels = { passingTouchdowns: 'passing touchdowns', passingYards: 'passing yards', interceptions: 'interceptions', rushingYards: 'rushing yards', rushingTouchdowns: 'rushing touchdowns' };
  const parts = Object.entries(labels).map(([key, label]) => {
    const c = value[key as keyof typeof labels];
    return c ? `${round(c.points)} from ${label}` : `${label} not supplied`;
  });
  const subsets = [['Designed runs', value.designedRuns], ['Scrambles', value.scrambles]] as const;
  value.explanation = `QB points: ${parts.join('; ')}${value.otherPoints ? `; ${round(value.otherPoints)} from other league rules` : ''}. `
    + (value.rushingPoints > 0 ? `Rushing contributes ${round(value.rushingPoints)} points to this ranking. ` : '')
    + (value.turnoverPoints < 0 ? `Projected turnovers reduce the total by ${round(-value.turnoverPoints)} points. ` : '')
    + subsets.map(([label, rows]) => rows ? `${label}: ${round(sum(rows))} points from supplied rushing subsets, already included above.` : `${label}: source breakdown unavailable.`).join(' ');
  return value;
}

export function scaleQuarterback(value: QuarterbackBreakdown, multiplier: number): QuarterbackBreakdown {
  const scale = (row: ScoringContribution | null) => row && ({ ...row, points: row.points * multiplier });
  return describeQuarterback({ ...value,
    ...Object.fromEntries(Object.keys(componentKeys).map(key => [key, scale(value[key as keyof typeof componentKeys])])),
    designedRuns: value.designedRuns?.map(row => scale(row)!) ?? null,
    scrambles: value.scrambles?.map(row => scale(row)!) ?? null,
    totalPoints: round(value.totalPoints * multiplier), otherPoints: value.otherPoints * multiplier,
    rushingPoints: value.rushingPoints * multiplier, turnoverPoints: value.turnoverPoints * multiplier,
    multiplier: value.multiplier * multiplier,
  });
}

export function quarterbackOutlook(week: ScoredWeek): QuarterbackOutlook | undefined {
  if (!week.mean.quarterback) return undefined;
  return {
    mean: scaleQuarterback(week.mean.quarterback, week.multiplier),
    floor: week.floor?.quarterback ? scaleQuarterback(week.floor.quarterback, week.multiplier) : null,
    ceiling: week.ceiling?.quarterback ? scaleQuarterback(week.ceiling.quarterback, week.multiplier) : null,
    adjustments: week.adjustments,
  };
}

/** Shows when the rushing differential actually decides a head-to-head ranking. */
export function quarterbackComparison(name: string, a: ScoredWeek, otherName: string, b: ScoredWeek): string {
  const left = quarterbackOutlook(a)?.mean, right = quarterbackOutlook(b)?.mean;
  if (!left || !right) return '';
  const rush = left.rushingPoints - right.rushingPoints;
  const turnovers = left.turnoverPoints - right.turnoverPoints;
  return ` ${name} versus ${otherName}: ${round(rush)} points from the rushing difference and ${round(turnovers)} from the turnover difference.`
    + (a.points > b.points && a.points - left.rushingPoints <= b.points - right.rushingPoints ? ' Rushing production drives the higher ranking.' : '');
}
