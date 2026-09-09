import type { QuarterbackBreakdown, QuarterbackOutlook } from '@sleeper/domain';

const rows = [
  ['passingTouchdowns', 'Passing touchdown points'], ['passingYards', 'Passing yardage points'],
  ['interceptions', 'Interception deductions'], ['rushingYards', 'Rushing yardage points'],
  ['rushingTouchdowns', 'Rushing touchdown points'],
] as const;
const points = (value: number | undefined) => value == null ? 'Not supplied' : value.toFixed(2);

/** All five components stay visible in the disclosure, even when a contribution is zero. */
export function QuarterbackDetail({ outlook, context }: { outlook?: QuarterbackOutlook; context?: string }) {
  if (!outlook) return null;
  const scenarios = [outlook.mean, outlook.floor, outlook.ceiling];
  const subset = (value: QuarterbackBreakdown | null, key: 'designedRuns' | 'scrambles') => {
    const entries = value?.[key];
    return entries ? `${entries.reduce((sum, c) => sum + c.points, 0).toFixed(2)} (${entries.map(c => `${c.amount} ${c.stat} × ${c.rate}`).join('; ')})` : 'Not supplied';
  };
  return <div className="quarterback-detail">
    <p>{outlook.mean.rushingPoints > 0 && <strong>Rushing contributes {outlook.mean.rushingPoints.toFixed(2)} points. </strong>}
      {outlook.mean.turnoverPoints < 0 && <strong>Projected turnovers cost {(-outlook.mean.turnoverPoints).toFixed(2)} points.</strong>}</p>
    <details><summary>Quarterback scoring and floor/ceiling</summary>
      <div className="table-scroll"><table>
        <caption>{context ? `${context} · ` : ''}Raw forecast scenarios scored under your league’s exact rules</caption>
        <thead><tr><th scope="col">Component</th><th scope="col">Mean</th><th scope="col">Floor</th><th scope="col">Ceiling</th></tr></thead>
        <tbody>{rows.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{scenarios.map((scenario, i) => <td key={i}>{scenario?.[key] ? `${points(scenario[key].points)} (${scenario[key].amount} × ${scenario[key].rate})` : 'Not supplied'}</td>)}</tr>)}
          <tr><th scope="row">Other league rules</th>{scenarios.map((s, i) => <td key={i}>{points(s?.otherPoints)}</td>)}</tr>
          <tr><th scope="row">Total points</th>{scenarios.map((s, i) => <td key={i}>{points(s?.totalPoints)}</td>)}</tr>
          <tr><th scope="row">Designed-run contribution (included in rushing)</th>{scenarios.map((s, i) => <td key={i}>{subset(s, 'designedRuns')}</td>)}</tr>
          <tr><th scope="row">Scramble contribution (included in rushing)</th>{scenarios.map((s, i) => <td key={i}>{subset(s, 'scrambles')}</td>)}</tr>
        </tbody>
      </table></div>
      <p>Each supplied scenario uses the same league rates. Missing scenarios and run splits remain unknown. Run subsets contain only the supplied yards or touchdowns and are already included in rushing totals.</p>
      {outlook.mean.multiplier !== 1 && <p>All component points and totals include the post-scoring multiplier {outlook.mean.multiplier.toFixed(3)}; raw amounts and league rates are shown before that adjustment.</p>}
      {outlook.adjustments.map((note, i) => <p key={i}>{note}</p>)}
    </details>
  </div>;
}
