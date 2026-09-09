import { QuarterbackDetail } from './QuarterbackDetail';
import { ScoringStatus } from './ScoringStatus';
import { useEffect, useState } from 'react';
import type { TradeOffer, TradeReport, TradeTeamImpact } from '@sleeper/domain';
import { request } from './api';
import { buildTradeMessage } from './trade-message';

const names = (assets: TradeOffer['give']) => assets.map(a => a.name).join(' + ');
export function TradeLineupComparison({ team }: { team: TradeTeamImpact }) {
  return <div className="trade-lineup"><h4>{team.name} · {team.strategy}</h4><p>{team.before.points.toFixed(1)} → {team.after.points.toFixed(1)} projected points</p>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${team.name} lineup comparison`}><table><caption>Projected week lineup before and after</caption><thead><tr><th scope="col">Slot</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>{team.before.slots.map((slot, i) => <tr key={i}><th scope="row">{slot.slot}</th><td>{slot.name}<small>{slot.points.toFixed(1)} pts</small></td><td>{team.after.slots[i]?.name ?? 'Empty slot'}<small>{(team.after.slots[i]?.points ?? 0).toFixed(1)} pts</small></td></tr>)}</tbody></table></div>
    <p>{team.after.legal ? 'Legal projected lineup' : 'Incomplete lineup'}</p>
    <ul>{team.needImprovements.map(i => <li key={i.need.key}>{i.need.position ?? 'Draft'} {i.need.kind}: {i.need.current} → {i.after} (+{i.gain} units)</li>)}</ul>
  </div>;
}
export function TradeMessageEditor({ offer }: { offer: TradeOffer }) {
  const [tone, setTone] = useState<'friendly' | 'direct'>('friendly');
  const [message, setMessage] = useState(() => buildTradeMessage(offer));
  const [status, setStatus] = useState('');
  return <div className="trade-message"><label>Editable trade message<textarea rows={5} value={message} onChange={e => { setMessage(e.target.value); setStatus(''); }}/></label>
    <div className="trade-message-actions"><label>Tone<select value={tone} onChange={e => setTone(e.target.value as typeof tone)}><option value="friendly">Friendly</option><option value="direct">Direct</option></select></label><button className="secondary-button" onClick={() => { setMessage(buildTradeMessage(offer, tone)); setStatus('Message regenerated; edits replaced.'); }}>Regenerate message</button><button className="primary-button" disabled={!message.trim()} onClick={async () => { try { await navigator.clipboard.writeText(message); setStatus('Message copied. Nothing has been sent.'); } catch { setStatus('Clipboard unavailable. Select and copy the editable text.'); } }}>Copy message</button></div><p role="status">{status}</p><small>Copy and send yourself in Sleeper. Regenerate replaces your edits.</small>
  </div>;
}
export function TradeOfferDetails({ offer }: { offer: TradeOffer }) {
  return <>
    <div className="trade-packages"><div><strong>You deliver</strong><p>{names(offer.give)}</p></div><div><strong>You receive</strong><p>{names(offer.receive)}</p></div></div>
    <div className="table-scroll"><table className="trade-values"><caption>Value by each team’s strategy · model units</caption><thead><tr><th scope="col">Team</th><th scope="col">Delivered</th><th scope="col">Received</th></tr></thead><tbody>{[offer.user, offer.partner].map(t => <tr key={t.rosterId}><th scope="row">{t.name}</th><td>{t.valueDelivered.toFixed(2)}</td><td>{t.valueReceived.toFixed(2)}</td></tr>)}</tbody></table></div>
    <p className="trade-model-note">Neutral package gap: {Math.round(offer.valueGap * 100)}% · Risk index: {Math.round(offer.risk * 100)}/100. Neither is an acceptance probability.</p>
    <details><summary>Player and pick valuation details</summary><ul>{offer.give.concat(offer.receive).map(a => <li key={a.id}><strong>{a.name} · {a.value.toFixed(2)} neutral units</strong><p>{a.explanation}</p>{a.quarterbackWeeks?.map(w => <div key={w.week}><strong>Week {w.week}</strong><QuarterbackDetail outlook={w.breakdown}/></div>)}{a.dynastyQuarterback && <div><strong>Future typical week</strong><QuarterbackDetail outlook={{ mean: a.dynastyQuarterback, floor: null, ceiling: null, adjustments: [] }}/></div>}</li>)}</ul></details>
    <div className="trade-lineups"><TradeLineupComparison team={offer.user}/><TradeLineupComparison team={offer.partner}/></div>
    <h4>Why the other manager might accept</h4><ul>{offer.whyAccept.map(r => <li key={r}>{r}</li>)}</ul>
    <h4>Primary risks</h4><ul>{offer.risks.map(r => <li key={r}>{r}</li>)}</ul>
    <TradeMessageEditor key={offer.id} offer={offer}/>
  </>;
}
export function TradeReportView({ report, demo }: { report: TradeReport; demo: boolean }) {
  const own = report.teams.find(t => t.rosterId === report.rosterId);
  return <>
    <ScoringStatus scoring={report.scoring}/><p className="trade-source">{demo ? 'Separate fictional trade scenario · ' : ''}{report.format} · Week {report.week}<br/>{report.source ? `${report.source.name} · Updated ${new Date(report.source.updatedAt).toLocaleString()}` : 'Forecast source unavailable'}</p>
    {own && <p><strong>Your plan: {own.strategy}.</strong> {own.needs.map(n => `${n.position ?? 'Draft'} ${n.kind}`).join(' · ') || 'No identified weakness.'}</p>}
    <details open={report.status === 'unavailable'}><summary>Coverage, constraints and method</summary><p>{report.methodology}</p><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul><p>Maximum value gap {Math.round(report.bounds.maxValueGap * 100)}%; risk index {Math.round(report.bounds.maxRisk * 100)}/100; minimum need gain {report.bounds.minNeedGain}. Dynasty rebuilder lineup loss capped at {Math.round(report.bounds.maxRebuilderLineupLoss * 100)}%.</p></details>
    {report.teams.length > 0 && <details><summary>Every roster’s needs, surplus and contention</summary>{report.teams.map(t => <div className="trade-team-summary" key={t.rosterId}><h4>{t.name} · {t.strategy}</h4><p>{t.strategyReason}</p><ul>{t.needs.map(n => <li key={n.key}>{n.explanation}</li>)}</ul>{!t.needs.length && <p>No identified weakness under these bounds.</p>}<p>Surplus without reducing this week’s optimal lineup: {t.surplus.map(a => a.name).join(', ') || 'None'}</p>{report.format === 'dynasty' && <p>Future draft capital: {t.futureCapital ? `${t.futureCapital.value} units · ${t.futureCapital.picks.map(p => p.name).join(', ') || 'No owned picks'}` : 'Unknown'}</p>}</div>)}</details>}
    {report.candidates.length ? <ol className="trade-candidates" aria-label="Trade candidates">{report.candidates.map((c, i) => <li key={c.id}><article><h3>#{i + 1} · Trade with {c.partner.name}</h3><TradeOfferDetails offer={c}/><details className="trade-fallback"><summary>Less expensive fallback{c.fallback ? ` · ${names(c.fallback.give)} for ${names(c.fallback.receive)}` : ' unavailable'}</summary><p>{c.fallbackReason}</p>{c.fallback && <TradeOfferDetails offer={c.fallback}/>}</details></article></li>)}</ol> : <p className="trade-empty">{report.status === 'unavailable' ? 'Trade analysis is unavailable. Review the missing data above.' : 'No mutually useful offers meet these bounds. Keep your roster or adjust the bounds and recheck.'}</p>}
    <p className="trade-model-note">Roster fit is a reason to start a conversation. No offer has been sent; confirm availability and league rules in Sleeper.</p>
  </>;
}
export function TradePlanner({ leagueId, userId, week, demo, force = false }: { leagueId: string; userId?: string; week: number; demo: boolean; force?: boolean }) {
  const [report, setReport] = useState<TradeReport | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0), [gap, setGap] = useState('.25'), [risk, setRisk] = useState('.65'), [format, setFormat] = useState('redraft');
  const query = new URLSearchParams({ week: String(week), force: String(force || retry > 0), maxValueGap: gap, maxRisk: risk, ...(demo ? { format } : {}) }).toString();
  const key = `${demo ? 'demo' : leagueId}:${query}:${retry}`;
  const [loadedKey, setLoadedKey] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReport(null); setError('');
    request<TradeReport>(`/api/trades/${encodeURIComponent(demo ? 'demo' : leagueId)}?${query}`, controller.signal).then(r => { if (!controller.signal.aborted) { setReport(r); setLoadedKey(key); setLoading(false); } }).catch(e => { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Trade analysis failed.'); setLoadedKey(key); setLoading(false); } });
    return () => controller.abort();
  }, [key, leagueId, demo, query]);
  const busy = loading || loadedKey !== key;
  return <div className="surface trade-planner" aria-busy={busy}><div className="trade-planner-heading"><strong>Mutual roster fit</strong><button className="secondary-button" disabled={busy} onClick={() => setRetry(v => v + 1)}>Recheck trades</button></div>
    <div className="trade-filters"><label>Maximum value gap<select value={gap} onChange={e => setGap(e.target.value)}><option value=".1">10% · Strict</option><option value=".25">25% · Balanced</option><option value=".4">40% · Flexible</option></select></label><label>Maximum risk index<select value={risk} onChange={e => setRisk(e.target.value)}><option value=".3">30 / 100</option><option value=".65">65 / 100</option><option value=".9">90 / 100</option></select></label>{demo && <label>Sample format<select value={format} onChange={e => setFormat(e.target.value)}><option value="redraft">Redraft</option><option value="dynasty">Dynasty</option></select></label>}</div>
    {busy ? <p role="status">Evaluating every roster, legal lineups and mutual needs…</p> : error ? <p role="alert">{error} Recheck to try again.</p> : report && <TradeReportView key={key} report={report} demo={demo}/>}
  </div>;
}
