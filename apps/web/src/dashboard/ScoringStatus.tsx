import { scoringSummary, scoringUnavailable, type ScoringConfiguration } from '@sleeper/domain';

export function ScoringStatus({ scoring = scoringUnavailable() }: { scoring?: ScoringConfiguration }) {
  const additions = scoring.issues.filter(issue => issue.kind === 'unexpected').length;
  const problems = scoring.issues.length - additions;
  return <section className="surface scoring-status" aria-label="Scoring snapshot">
    <strong>{scoring.kind === 'complete-live' ? 'Validated live scoring' : scoring.kind === 'partial-reference' ? 'Partial scoring reference' : 'Scoring unavailable'}</strong>
    <p>{scoringSummary(scoring)}</p>
    <p>{scoring.synchronizedAt ? <>Scoring synchronized: <time dateTime={scoring.synchronizedAt}>{new Date(scoring.synchronizedAt).toLocaleString()}</time>{scoring.kind === 'unavailable' ? ' · Validation or refresh failed' : ''}</> : 'Scoring has not been synchronized.'}</p>
    {scoring.lastAttemptedAt && <p>Last refresh attempt: <time dateTime={scoring.lastAttemptedAt}>{new Date(scoring.lastAttemptedAt).toLocaleString()}</time></p>}
    {scoring.kind === 'partial-reference' && <p>Reference values cannot produce actionable rankings.</p>}
    {scoring.issues.length > 0 && <details><summary>{problems} scoring issue(s) · {additions} additional Sleeper rule(s) preserved</summary><ul>{scoring.issues.map((issue, i) => <li key={`${issue.kind}:${issue.key}:${i}`}>{issue.message}</li>)}</ul></details>}
  </section>;
}
