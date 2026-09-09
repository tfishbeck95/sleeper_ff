import { ScoringStatus } from './ScoringStatus';
import { ScoringBreakdown } from './ScoringBreakdown';
import { OpportunityDetail } from './OpportunityDetail';
import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, TrendingUp } from 'lucide-react';
import type { WaiverReport } from '@sleeper/domain';
import { request } from './api';
import { buildWaiverPlan, defaultWaiverFilters, filterWaivers, horizonLabels, needLabels, type WaiverFilters } from './waiver-plan';

const delta = (value: number | null) => value == null ? 'Unknown' : `${value > 0 ? '+' : ''}${value.toFixed(1)} pts`;

export function WaiverPlanner({ leagueId, userId, week, demo, force = false }: { leagueId: string; userId?: string; week: number; demo: boolean; force?: boolean }) {
  const [report, setReport] = useState<WaiverReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<WaiverFilters>(defaultWaiverFilters);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReport(null); setError(''); setCopyStatus(''); setExcluded(new Set()); setFilters(defaultWaiverFilters);
    const query = new URLSearchParams({ userId: userId ?? 'sample', week: String(week), force: String(force || retry > 0) });
    request<WaiverReport>(`/api/waivers/${encodeURIComponent(demo ? 'demo' : leagueId)}?${query}`, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setReport(value); setLoading(false); } })
      .catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Waiver analysis failed.'); setLoading(false); } });
    return () => controller.abort();
  }, [leagueId, userId, week, demo, force, retry]);
  const visible = useMemo(() => filterWaivers(report?.recommendations ?? [], filters), [report, filters]);
  const selected = visible.filter(r => !excluded.has(r.id));
  const plan = report ? buildWaiverPlan(report, selected) : '';
  const setFilter = (key: keyof WaiverFilters, value: string) => { setFilters(v => ({ ...v, [key]: value })); setCopyStatus(''); };
  return <div className="surface waiver-planner" aria-busy={loading}>
    <div className="waiver-planner-heading"><span><TrendingUp size={17}/> Ranked add / drop pairs</span><button className="secondary-button" onClick={() => setRetry(v => v + 1)} disabled={loading}><RefreshCw size={14}/> Recheck</button></div>
    {loading ? <p role="status">Checking league ownership, availability and forecasts…</p> : error ? <p role="alert">{error} Use Recheck to try again. No waiver plan is available.</p> : report && <>
      <ScoringStatus scoring={report.scoring}/>
      <p className="waiver-source">{demo ? 'Separate waiver sample · Dynasty · $100 FAAB · ' : ''}{report.source ? `${report.source.name} · Updated ${new Date(report.source.updatedAt).toLocaleString()}` : 'Forecast source unavailable'}<br/>{report.rosteredCount} rostered · {report.eligibleCount} acquisition candidates · {report.evaluatedCount} with forecasts</p>
      <div className="waiver-filters">
        <label>Position<select value={filters.position} onChange={e => setFilter('position', e.target.value)}><option value="all">All positions</option>{[...new Set(report.recommendations.flatMap(r => r.add.positions))].sort().map(p => <option key={p}>{p}</option>)}</select></label>
        <label>Time horizon<select value={filters.horizon} onChange={e => setFilter('horizon', e.target.value)}><option value="all">All horizons</option>{Object.entries(horizonLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Risk<select value={filters.risk} onChange={e => setFilter('risk', e.target.value)}><option value="all">All risks</option>{['low', 'medium', 'high'].map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>
        <label>Roster need<select value={filters.need} onChange={e => setFilter('need', e.target.value)}><option value="all">All needs</option>{Object.entries(needLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <p className="waiver-plan-note">Pairs are ranked alternatives. The copyable plan merges duplicate players and treats repeated drops as fallback claims. {visible.length} matching pairs.</p>
      {report.rejected.length > 0 && <details className="waiver-coverage"><summary>{report.rejected.length} refused projection(s) — excluded, never scored as zero</summary><ul>{report.rejected.map(r => <li key={`${r.playerId}:${r.kind}:${r.message}`}>{r.message}</li>)}</ul></details>}
      {report.warnings.length > 0 && <details className="waiver-coverage" open={report.status === 'unavailable'}><summary>{report.status === 'unavailable' ? 'Analysis unavailable' : 'Data coverage & league constraints'}</summary><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}
      {visible.length > 0 ? <ol className="waiver-pair-list" aria-label="Ranked add and drop recommendations">{visible.map(r => <li key={r.id}>
        <article className="waiver-pair"><div className="waiver-pair-top"><strong>#{r.priority}</strong><span>{horizonLabels[r.horizon]}</span><span className={`waiver-risk risk-${r.risk}`}>{r.risk} risk</span><label className="waiver-include"><input type="checkbox" checked={!excluded.has(r.id)} aria-label={`Include ${r.add.name}, ${horizonLabels[r.horizon]}, in waiver plan`} onChange={() => { setExcluded(v => { const next = new Set(v); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); return next; }); setCopyStatus(''); }}/> Plan</label></div>
          <h3><span className="waiver-add-label">ADD</span> {r.add.name} <small>{r.add.positions.join('/')} · {r.add.team ?? 'Free agent'}</small></h3>
          <p className="waiver-drop"><strong>{r.drop ? `DROP ${r.drop.name}` : 'No drop needed — open active slot'}</strong></p>
          <p className="waiver-need">{needLabels[r.need]} · {r.pointsExplanation}</p>
          <ScoringBreakdown contributions={r.contributions} label={report.scoringLabel} context={r.horizon === 'dynasty' ? 'the projected future typical week' : `the week ${report.week} stat line`}/>
          <OpportunityDetail profile={r.opportunity}/>
          <dl className="waiver-comparisons"><div><dt>vs. eligible starter{r.starterComparison ? ` · ${r.starterComparison.name}` : ''}</dt><dd>{delta(r.starterGain)}</dd></div><div><dt>vs. weakest valued bench{r.weakestBench ? ` · ${r.weakestBench.name}` : ''}</dt><dd>{delta(r.benchGain)}</dd></div></dl>
          <p className="waiver-drop-reason">{r.dropReason}</p>
          <div className="waiver-upcoming" aria-label={`Upcoming schedule for ${r.add.name}`}>{r.upcoming.map(w => <span key={w.week}>W{w.week}: {w.bye ? 'BYE' : w.opponent ?? 'Opponent unknown'}<strong>{w.points == null ? 'Projection unknown' : `${w.points.toFixed(1)} pts`}</strong></span>)}</div>
          {r.faab ? <div className="waiver-faab"><strong>FAAB ${r.faab.min}–${r.faab.max} <small>of ${r.faab.remaining} remaining · {r.faab.urgency} urgency</small></strong><p>{r.faab.explanation}</p></div> : <p className="waiver-plan-note">No dollar advice: priority waivers or an unverified FAAB balance. Check your league’s claim rules.</p>}
          <details className="waiver-reasoning"><summary>Why this pair & what could change</summary><ul>{r.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>{r.uncertainty.length > 0 && <><strong>Uncertainty</strong><ul>{r.uncertainty.map(reason => <li key={reason}>{reason}</li>)}</ul></>}</details>
        </article>
      </li>)}</ol> : <p className="waiver-empty">{report.recommendations.length ? 'No pairs match these filters. Try a different horizon, risk, position or need.' : 'No supported upgrades to show. Check data coverage above; keeping your current roster may be the best move.'}</p>}
      <div className="waiver-plan-actions"><button className="primary-button" disabled={!selected.length} onClick={async () => { try { await navigator.clipboard.writeText(plan); setCopyStatus('Waiver plan copied. Submit the claims yourself in Sleeper.'); } catch { setCopyStatus('Clipboard access failed. Select and copy the plan text below.'); } }}><Copy size={16}/> Copy priority plan</button>{!demo && report.submission.url && <a className="text-link" href={report.submission.url} target="_blank" rel="noopener noreferrer">Submit in Sleeper <ExternalLink size={14}/><span className="sr-only"> (opens in a new tab)</span></a>}</div>
      <p role="status" className="waiver-copy-status">{copyStatus}</p>
      {selected.length > 0 && <details className="waiver-plan-preview"><summary>Preview copyable priority plan</summary><textarea readOnly aria-label="Copyable waiver plan" value={plan} rows={12}/></details>}
      <p className="waiver-manual-note">{report.submission.instruction}</p>
    </>}
  </div>;
}
