import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CircleAlert, Flag, Info, ListChecks, RefreshCw, Sparkles, Target, TrendingUp, Users, Zap } from 'lucide-react';
import type { DashboardData, DashboardPlayer, ProposedAction, StartDecision, WaiverTarget } from './types';

export const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1);
export const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
export const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('');
export const formattedTime = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not synchronized';

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{children}</p></div>;
}
export function SectionHeader({ id, number: index, title, subtitle, children }: { id: string; number: string; title: string; subtitle: string; children?: ReactNode }) {
  return <div className="section-heading"><div><div className="section-title"><span className="section-number">{index}</span><h2 id={id}>{title}</h2></div><p>{subtitle}</p></div>{children}</div>;
}
export function Confidence({ value }: { value?: number }) {
  return value == null ? <span className="confidence unknown">Confidence unavailable</span> : <span className={`confidence ${value >= 80 ? 'high' : 'moderate'}`}><span className="confidence-bars" aria-hidden="true"><i/><i/><i/><i/></span>{value}% confidence</span>;
}
function PlayerRow({ player, type }: { player?: DashboardPlayer; type: 'start' | 'sit' }) {
  return <div className={`decision-player ${type}`}><span className="decision-label">{type === 'start' ? <TrendingUp size={13}/> : <ArrowDown size={13}/>} {type}</span>{player ? <><span className={`player-avatar position-${player.position.toLowerCase()}`} aria-hidden="true">{initials(player.name)}</span><div className="player-name"><strong>{player.name}</strong><span>{player.position} · {player.team}</span></div><div className="player-projection"><strong>{number(player.illustrativePoints)}</strong><span>sample pts</span></div></> : <p>Player comparison unavailable</p>}</div>;
}
export function StartCard({ decision, onReview }: { decision: StartDecision; onReview: (action: ProposedAction) => void }) {
  return <article className="start-card"><div className="card-meta"><span className="recommendation-label"><Sparkles size={13}/> Recommendation</span><span>{decision.slot ?? 'Lineup'}</span></div>
    {decision.start ? <><PlayerRow player={decision.start} type="start"/><PlayerRow player={decision.sit} type="sit"/></> : <h3 className="generic-recommendation">{decision.title}</h3>}
    <p className="reason">{decision.reason}</p><div className="decision-evidence"><span className="advantage">{decision.advantage == null ? 'Advantage unavailable' : `${signed(decision.advantage)} projected pts`}</span><Confidence value={decision.confidence}/></div>
    <button className="review-button" onClick={() => onReview(decision)}>Review recommendation <ArrowRight size={16}/></button>
  </article>;
}
export function WaiverRow({ target, rank, onReview }: { target: WaiverTarget; rank: number; onReview: (action: ProposedAction) => void }) {
  return <tr><td className="rank-cell">{String(rank).padStart(2, '0')}</td><td><div className="waiver-player"><span className={`player-avatar position-${target.player?.position.toLowerCase() ?? 'wr'}`} aria-hidden="true">{target.player ? initials(target.player.name) : <Users size={17}/>}</span><div><strong>{target.player?.name ?? target.title}</strong><span>{target.player ? `${target.player.position} · ${target.player.team}` : 'Player not specified'}</span></div></div></td><td data-label="Roster fit"><span className={`fit-status ${target.fit != null && target.fit >= 85 ? 'strong' : ''}`}><Check size={13}/>{target.fitLabel}</span><small>{target.fit == null ? 'Fit score unavailable' : `${target.fit}/100 roster fit`}</small></td><td data-label="Weekly upside"><strong className="advantage">{target.advantage == null ? '—' : `${signed(target.advantage)} pts`}</strong><small>{target.drop ? `over ${target.drop.name}` : 'Comparison unavailable'}</small></td><td><button className="table-review" onClick={() => onReview(target)} aria-label={`Review recommendation: ${target.title}`}>Review <ArrowUpRight size={15}/></button></td></tr>;
}
export function MatchupCard({ data }: { data: DashboardData }) {
  const [view, setView] = useState<'paths' | 'risks'>('paths');
  const tabId = useId();
  const matchup = data.matchup;
  if (!matchup) return <div className="surface matchup-empty"><EmptyState icon={<Target/>} title="No matchup available">Select the scheduled week, or check back when your league has a matchup.</EmptyState></div>;
  // Illustrative demo figures only; a connected league's league-scored totals render in LineupAnalysis.
  const margin = matchup.illustrativeFor != null && matchup.illustrativeAgainst != null ? matchup.illustrativeFor - matchup.illustrativeAgainst : null;
  return <div className="matchup-card"><div className="matchup-kicker"><span><span className="live-dot"/> WEEK {data.week} OUTLOOK</span><span>{data.demo ? 'Sample projections' : 'League matchup'}</span></div><div className="matchup-teams"><div><span className="team-mark home" aria-hidden="true"><Flag size={22}/></span><strong>{data.teamName}</strong><span>You</span></div><span className="versus">VS</span><div><span className="team-mark away" aria-hidden="true"><Zap size={22}/></span><strong>{matchup.opponent}</strong><span>Opponent</span></div></div>
    <div className="score-comparison"><div><strong>{number(matchup.illustrativeFor)}</strong><span>{data.demo ? 'sample points' : 'league-scored total below'}</span></div><span className="score-dash">:</span><div><strong>{number(matchup.illustrativeAgainst)}</strong><span>{data.demo ? 'sample points' : 'league-scored total below'}</span></div></div>
    {matchup.actualFor != null && <p className="actual-score">Current score: {number(matchup.actualFor)} – {number(matchup.actualAgainst)}</p>}
    <div className="matchup-odds"><div><span>{margin == null ? 'Projection unavailable' : margin === 0 ? 'Evenly projected' : margin > 0 ? 'A slight edge for you' : 'You’re the projected underdog'}</span><strong>{matchup.winChance == null ? 'Odds unavailable' : `${matchup.winChance}% to win`}</strong></div>{matchup.winChance != null && <div className="win-meter" role="img" aria-label={`${matchup.winChance}% sample chance to win, ${100 - matchup.winChance}% chance to lose`}><span style={{ width: `${matchup.winChance}%` }}/></div>}<p>{margin == null ? 'Your league-scored matchup total and win probability appear below, from your league’s own scoring rules.' : `${signed(margin)} projected point margin · ${data.demo ? 'Illustrative estimate' : 'Not a guaranteed outcome'}`}</p></div>
    <div className="outlook-tabs" role="tablist" aria-label="Matchup analysis" onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'paths' : event.key === 'End' ? 'risks' : view === 'paths' ? 'risks' : 'paths'; setView(next); document.getElementById(`${tabId}-${next}`)?.focus(); } }}><button id={`${tabId}-paths`} role="tab" aria-selected={view === 'paths'} aria-controls={`${tabId}-panel`} tabIndex={view === 'paths' ? 0 : -1} onClick={() => setView('paths')}><TrendingUp size={14}/> Paths to win</button><button id={`${tabId}-risks`} role="tab" aria-selected={view === 'risks'} aria-controls={`${tabId}-panel`} tabIndex={view === 'risks' ? 0 : -1} onClick={() => setView('risks')}><CircleAlert size={14}/> Downside risks</button></div>
    <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${view}`} tabIndex={0} className="outlook-panel">{(view === 'paths' ? matchup.paths : matchup.risks).length ? <ul>{(view === 'paths' ? matchup.paths : matchup.risks).map(text => <li key={text}>{text}</li>)}</ul> : <p>There isn’t enough projection data to explain {view === 'paths' ? 'a path to win' : 'specific downside risks'} yet.</p>}</div>
  </div>;
}
export function LoadingDashboard() {
  return <div className="loading-dashboard" role="status" aria-live="polite" aria-busy="true"><p><RefreshCw size={17} className="spin"/> Loading your league, roster, and matchup…</p><div className="skeleton skeleton-heading"/><div className="skeleton-alerts">{[0, 1, 2, 3].map(n => <div key={n} className="skeleton"/>)}</div><div className="skeleton-grid"><div className="skeleton"/><div className="skeleton"/></div><span className="sr-only">Recommendations will appear after your league data loads.</span></div>;
}
