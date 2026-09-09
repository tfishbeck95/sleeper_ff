import type { SpecialTeamsBreakdown, SpecialTeamsCoverageStatus } from '@sleeper/domain';

const coverageLabels: Record<SpecialTeamsCoverageStatus, string> = {
  complete: 'Complete coverage', partial: 'Incomplete coverage', absent: 'No return scoring modeled',
  'not-scored': 'Not scored by this league',
};
const relevanceLabels = {
  designated: 'Designated return role', unknown: 'Return role unknown', 'not-relevant': 'No return duty',
} as const;
const amount = (value: number | null) => value === null ? 'Not modeled' : value.toFixed(2);
const rate = (value: number | null) => value === null ? 'Rule undefined' : String(value);

/**
 * A rostered player's own `st_*` scoring. An unmodeled category renders as "Not modeled", never as a
 * zero, and no estimated return bonus is ever shown in its place.
 */
export function SpecialTeamsDetail({ forecast, context }: { forecast?: SpecialTeamsBreakdown; context?: string }) {
  const s = forecast;
  if (!s || (s.coverage === 'not-scored' && s.otherPoints === 0)) return null;
  const incomplete = s.coverage === 'partial' || s.coverage === 'absent';
  return <div className="quarterback-detail">
    <p><strong>{context ? `${context}: ` : ''}Special teams {s.expectedPoints.toFixed(2)} points · {coverageLabels[s.coverage]} · {relevanceLabels[s.relevance]}.</strong></p>
    {s.availabilityNote && <p>{s.availabilityNote}</p>}
    <p>{s.explanation}</p>
    <details><summary>Individual return scoring, coverage and what is unknown</summary>
      <div className="table-scroll"><table>
        <caption>This player’s own Sleeper rules and your league’s rates</caption>
        <thead><tr><th scope="col">Category</th><th scope="col">Sleeper rule</th><th scope="col">Team rule</th><th scope="col">Expected count</th><th scope="col">Rate</th><th scope="col">Points</th></tr></thead>
        <tbody>{s.components.map(c => <tr key={c.stat}><th scope="row">{c.label}</th><td><code>{c.stat}</code></td><td><code>{c.teamStat}</code></td><td>{amount(c.amount)}</td><td>{rate(c.rate)}</td><td>{c.points.toFixed(2)}</td></tr>)}</tbody>
      </table></div>
      <p>The individual <code>st_*</code> rules pay this player; the team <code>def_st_*</code> rules pay the D/ST unit, at different rates for the same real event. One entity never carries both, so a return touchdown is never scored twice.</p>
      {incomplete && <p>A category shown as “Not modeled” is <strong>unknown, not zero</strong>. Your league’s rate for it is listed so you can see what is missing; no expected return touchdown is invented to fill the gap, and return upside adds {s.rankingAdjustment} to every ranking on this page.</p>}
      {s.otherPoints !== 0 && <p>A further {s.otherPoints.toFixed(2)} points come from other individual special-teams rules on the same stat line.</p>}
      {s.uncertainty.length > 0 && <ul>{s.uncertainty.map(note => <li key={note}>{note}</li>)}</ul>}
    </details>
  </div>;
}
