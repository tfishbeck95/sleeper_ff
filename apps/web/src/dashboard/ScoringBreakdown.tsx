import type { ScoringContribution } from '@sleeper/domain';

/**
 * The major scoring contributions, on demand. Every points figure in this app is the selected
 * league's own rules applied to a provider's raw statistics; this discloses that arithmetic so a
 * manager can see which statistics produced the number rather than trusting an opaque projection.
 *
 * The headline total is summed from the contributions themselves, so the disclosure can never
 * advertise a number its own rows do not add up to.
 */
export function ScoringBreakdown({ contributions, label, context, limit = 5 }: { contributions: ScoringContribution[]; label: string; context?: string; limit?: number }) {
  if (!contributions.length) return <p className="scoring-breakdown-empty">No supplied statistic scores under your league’s {label} rules, so this total is zero rather than unknown.</p>;
  const total = contributions.reduce((sum, value) => sum + value.points, 0);
  const shown = contributions.slice(0, limit);
  const remainder = contributions.slice(limit);
  const rest = remainder.reduce((sum, value) => sum + value.points, 0);
  return <details className="scoring-breakdown">
    <summary>How your league’s {label} scoring produced {total.toFixed(1)} points{context ? ` from ${context}` : ''}</summary>
    <table>
      <caption className="sr-only">Raw statistics, your league’s rate for each, and the points they contribute.</caption>
      <thead><tr><th scope="col">Statistic</th><th scope="col">Projected</th><th scope="col">Your rate</th><th scope="col">Points</th></tr></thead>
      <tbody>
        {shown.map(value => <tr key={value.stat}><th scope="row">{value.stat}</th><td>{Math.round(value.amount * 100) / 100}</td><td>{value.rate}</td><td>{value.points.toFixed(2)}</td></tr>)}
        {remainder.length > 0 && <tr><th scope="row">{remainder.length} smaller contribution(s)</th><td colSpan={2}/><td>{rest.toFixed(2)}</td></tr>}
      </tbody>
    </table>
    <p>Raw statistics come from your forecast source. The rates are your league’s synchronized scoring settings; no other scoring is applied.</p>
  </details>;
}
