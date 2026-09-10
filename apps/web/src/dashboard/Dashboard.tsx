import { CommandCenterStatus } from './CommandCenterStatus';
import { ScoringStatus } from './ScoringStatus';
import type { CommandCenterResponse } from '@sleeper/domain';
import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeftRight, ArrowRight, ArrowUpRight, Bell, CalendarDays, ChevronDown, ChevronRight, CircleAlert, Clock3, ExternalLink, Flag, HeartPulse, Info, LayoutDashboard, ListChecks, Menu, Plus, RefreshCw, ShieldCheck, Target, TrendingUp, Trophy, Users, X } from 'lucide-react';
import { Button } from '@sleeper/ui';
import { ActionDialog } from './ActionDialog';
import { WaiverPlanner } from './WaiverPlanner';
import { LineupAnalysis, useLineupReport } from './LineupAnalysis';
import { TradePlanner } from './TradePlanner';
import { EmptyState, formattedTime, initials, LoadingDashboard, MatchupCard, number, SectionHeader, StartCard } from './components';
import { createDemo } from './demo';
import { fromCommandCenter, sleeperLeagueUrl, sortAlerts, syncAlert } from './model';
import { loadCommandCenter, queueSync } from './api';
import type { AlertKind, DashboardConnection, DashboardData, ProposedAction } from './types';

const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'lineup', label: 'Start / sit', icon: ListChecks },
  { id: 'matchup', label: 'Matchup', icon: Target },
  { id: 'waivers', label: 'Waivers', icon: TrendingUp },
  { id: 'trades', label: 'Trades', icon: ArrowLeftRight },
  { id: 'league', label: 'League pulse', icon: Activity },
];
const alertIcons = { inactive: CircleAlert, bye: CalendarDays, injury: HeartPulse, empty: Plus, sync: RefreshCw };
const alertLabels: Record<AlertKind, string> = { inactive: 'Inactive', bye: 'Bye week', injury: 'Injury', empty: 'Empty slot', sync: 'Sync failure' };

export function Dashboard({ connection, onConnect, onDemo, onSignOut }: { connection: DashboardConnection | null; onConnect: () => void; onDemo: () => void; onSignOut?: () => void }) {
  const [leagueId, setLeagueId] = useState(connection?.leagues[0]?.league.league_id ?? 'demo');
  const [week, setWeek] = useState(connection?.leagues[0]?.league.settings.leg || 1);
  const [reload, setReload] = useState(0);
  const demoData = useMemo(createDemo, []);
  const [bounds, setBounds] = useState({ maxValueGap: '.25', maxRisk: '.65' });
  const key = `${connection?.user.user_id ?? 'demo'}:${leagueId}:${week}:${bounds.maxValueGap}:${bounds.maxRisk}`;
  const [result, setResult] = useState<{ key: string; data: DashboardData; command: CommandCenterResponse } | null>(null);
  const [requestState, setRequestState] = useState<{ key: string; busy: boolean; error: string }>({ key, busy: Boolean(connection), error: '' });
  const [action, setAction] = useState<ProposedAction | null>(null);
  const [activeNav, setActiveNav] = useState('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullStandings, setFullStandings] = useState(false);
  const [status, setStatus] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!connection) return;
    const controller = new AbortController();
    setRequestState({ key, busy: true, error: '' });
    loadCommandCenter(leagueId, week, controller.signal, bounds).then(command => {
      if (controller.signal.aborted) return;
      setResult({ key, data: fromCommandCenter(command), command });
      setRequestState({ key, busy: false, error: '' });
      setStatus('League refreshed. Recommendations still need your confirmation in Sleeper.');
    }).catch(error => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error && error.name === 'TimeoutError' ? 'The sync timed out. Please try again.' : error instanceof Error ? error.message : 'Your league could not be synchronized.';
      setRequestState({ key, busy: false, error: message });
      setStatus(`Sync failed. ${message}`);
    });
    return () => controller.abort();
  }, [connection, leagueId, week, reload, key, bounds]);
  useEffect(() => { setAction(null); setFullStandings(false); setStatus(''); }, [key]);
  const data = connection ? result?.key === key ? result.data : null : demoData;
  const busy = Boolean(connection) && (requestState.key !== key || requestState.busy);
  const error = requestState.key === key ? requestState.error : '';
  const stale = Boolean(data?.lastSyncedAt && now - Date.parse(data.lastSyncedAt) > 30 * 60_000);
  const alerts = sortAlerts([...(data?.alerts ?? []).filter(alert => !(error || stale) || alert.kind !== 'sync'), ...(error ? [syncAlert(`${error} ${data ? 'Showing the last successful snapshot.' : ''}`)] : stale ? [syncAlert('Your last successful sync is over 30 minutes old. Refresh before making a decision.')] : [])]);
  /**
   * Manual refresh.
   *
   * Pressing this queues the same background job the scheduler runs and returns immediately; it never
   * asks the API to synchronize the league inside the request. The view is reloaded either way, so a
   * league that is already up to date still repaints, and the queued synchronization lands on a later
   * refresh rather than blocking this one.
   */
  const refresh = async () => {
    if (!connection) { setStatus('Sample scenario reloaded. This is illustrative data, not a live sync.'); return; }
    try {
      const queued = await queueSync(leagueId, week);
      setStatus(queued.running ? 'A refresh is already running. Your league is being synchronized in the background.' : 'Refresh queued. Your league is being synchronized in the background.');
    } catch (queueError) {
      setStatus(`The refresh could not be queued. ${queueError instanceof Error ? queueError.message : 'Please try again.'}`);
    } finally {
      setReload(v => v + 1);
    }
  };
  const onRefresh = () => { void refresh(); };
  const nav = (mobile = false) => <nav aria-label={mobile ? 'Mobile dashboard sections' : 'Dashboard sections'}>{navigation.map(({ id, label, icon: Icon }) => <a key={id} aria-label={label} title={label} href={`#${id}`} className={activeNav === id ? 'active' : ''} aria-current={activeNav === id ? 'location' : undefined} onClick={() => { setActiveNav(id); setMenuOpen(false); }}><Icon size={19}/><span>{label}</span>{id === 'overview' && alerts.length > 0 && <span className="nav-count">{alerts.length}<span className="sr-only"> alerts</span></span>}</a>)}</nav>;
  const userStanding = data?.standings.find(t => t.isUser);
  const rank = data?.standings.findIndex(t => t.isUser);
  const leagueUrl = sleeperLeagueUrl(leagueId);
  const command = connection && result?.key === key ? result.command : null;
  const recheck = () => setReload(v => v + 1);
  const demoLineup = useLineupReport({ leagueId, userId: connection?.user.user_id, week: data?.week ?? week, demo: data?.demo ?? !connection, force: reload > 0, enabled: !connection });
  const lineup = connection ? { report: command?.sections.lineup.data ?? null, loading: busy, error: command?.sections.lineup.state === 'error' ? command.sections.lineup.warnings.join(' ') : error, recheck } : demoLineup;
  return <div className="dashboard-shell"><a className="skip-link" href="#dashboard-main">Skip to dashboard</a>
    <aside className="sidebar"><a className="brand" href="#overview" aria-label="Huddle dashboard"><span className="brand-mark">h<span/></span><span>huddle<span className="brand-period">.</span></span></a><span className="sidebar-label">YOUR WORKSPACE</span>{nav()}<div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={23}/><strong>Your team. Your call.</strong><p>Smart recommendations.<br/>You confirm in Sleeper.</p><span><span className="live-dot"/> Always read-only</span></div><button className="account-button" onClick={onConnect}><span className="account-avatar">{initials(connection?.user.display_name ?? 'Sample Manager')}</span><span><strong>{connection?.user.display_name ?? 'Sample manager'}</strong><small>{connection ? 'Manage connection' : 'Connect your Sleeper'}</small></span><ChevronRight size={16}/></button>{onSignOut && <button className="sign-out-button" onClick={onSignOut}>Sign out</button>}</div></aside>
    <div className="dashboard-workspace"><header className="topbar"><div className="breadcrumb"><LayoutDashboard size={17}/><span>Workspace</span><ChevronRight size={14}/><strong>{navigation.find(item => item.id === activeNav)?.label}</strong></div><a className="mobile-brand" href="#overview">huddle.</a><div className="topbar-actions"><span className="read-only"><ShieldCheck size={15}/> Read-only</span><a className="icon-button notification-button" href="#alerts" aria-label={`${alerts.length} alerts. Go to urgent alerts.`}><Bell size={20}/>{alerts.length > 0 && <span/>}</a><span className="topbar-avatar" aria-label={connection?.user.display_name ?? 'Sample manager'}>{initials(connection?.user.display_name ?? 'Sample Manager')}</span><button className="icon-button mobile-menu-button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(v => !v)}>{menuOpen ? <X/> : <Menu/>}</button></div></header>
    {menuOpen && <div className="mobile-navigation" id="mobile-navigation">{nav(true)}<button onClick={onConnect}>Manage Sleeper connection <ArrowUpRight size={16}/></button></div>}
    <main id="dashboard-main" tabIndex={-1} className="dashboard-main"><section id="overview" className="overview-heading"><div><p className="eyebrow"><span className="live-dot"/> YOUR WEEKLY GAME PLAN</p><h1>Let’s get your lineup ready<span>.</span></h1><p>The important calls, all in one huddle.</p></div><div className="week-control"><CalendarDays size={17}/>{connection ? <label><span className="sr-only">Matchup week</span><select value={week} onChange={e => setWeek(Number(e.target.value))}>{Array.from({ length: 18 }, (_, i) => <option key={i + 1} value={i + 1}>Week {i + 1}</option>)}</select></label> : <span>Week 8 <small>Sample</small></span>}</div></section>
    <div className="league-toolbar"><div className="league-identity"><span className="league-icon"><Trophy size={19}/></span><div>{connection ? <label><span className="sr-only">Selected league</span><select value={leagueId} onChange={e => { const next = connection.leagues.find(l => l.league.league_id === e.target.value); setLeagueId(e.target.value); setWeek(next?.league.settings.leg || 1); }} aria-label="Selected league">{connection.leagues.map(c => <option key={c.league.league_id} value={c.league.league_id}>{c.league.name}</option>)}</select></label> : <strong>Sunday Legends</strong>}<span>{data?.format ?? 'Loading league settings'}{userStanding && <> <span className="toolbar-divider">/</span> {userStanding.wins}–{userStanding.losses}{userStanding.ties ? `–${userStanding.ties}` : ''} · #{(rank ?? 0) + 1}</>}</span></div></div><div className="sync-controls"><span className={error || stale ? 'sync-time sync-warning' : 'sync-time'}><Clock3 size={14}/>{data?.demo ? 'Illustrative data' : busy ? 'Syncing league…' : error ? 'Sync failed · last data retained' : `Synced ${formattedTime(data?.lastSyncedAt ?? null)}`}</span><button className="secondary-button" onClick={onRefresh} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''}/>{data?.demo ? 'Reload sample' : 'Refresh'}</button></div></div>
    {!connection && <div className="demo-banner"><div><Info size={16}/><span><strong>You’re exploring a sample league.</strong> Players are fictional. Alerts and estimates illustrate the experience, not current NFL advice.</span></div><button onClick={onConnect}>Connect Sleeper <ArrowUpRight size={15}/></button></div>}
    <p className="sr-only" role="status" aria-live="polite">{status}</p>
    {busy && !data ? <LoadingDashboard/> : !data ? <div className="surface initial-error" role="alert"><EmptyState icon={<CircleAlert/>} title="We couldn’t load your league">{error || 'Your league data is not available yet.'} No recommendations are being shown.</EmptyState><div><Button onClick={onRefresh}><RefreshCw size={16}/> Try again</Button><button className="secondary-button" onClick={onDemo}>Explore sample dashboard</button></div></div> : <>
    {command && <CommandCenterStatus command={command}/>}
    <ScoringStatus scoring={data.scoring}/>
    <section className="alerts-section" id="alerts" aria-labelledby="alerts-title"><div className="alerts-header"><div><span className="alert-heading-icon"><CircleAlert size={20}/></span><h2 id="alerts-title">First things first</h2><span className={`count-badge ${alerts.length ? '' : 'clear'}`}>{alerts.length} to review</span></div><span>Before your players lock</span></div>{alerts.length > 0 ? <div className="alerts-grid">{alerts.map(alert => { const Icon = alertIcons[alert.kind]; return <button key={alert.id} className={`alert-item alert-${alert.kind}`} onClick={() => setAction(alert.action)}><span className="alert-type"><Icon size={17}/>{alertLabels[alert.kind]}</span><strong>{alert.title}</strong><span className="alert-detail">{alert.detail}</span><span className="alert-review">Review {alert.kind === 'sync' ? 'sync checklist' : 'recommendation'} <ArrowRight size={14}/></span></button>; })}</div> : <div className="alerts-clear"><ShieldCheck size={20}/><div><strong>{data.coverageNote ? 'No empty starter slots found' : 'No urgent alerts found'}</strong><p>Keep an eye on player availability before kickoff.</p></div></div>}{data.coverageNote && <p className="coverage-note"><Info size={15}/>{data.coverageNote}</p>}</section>
    <div className="decision-layout"><section id="lineup" aria-labelledby="lineup-title"><SectionHeader id="lineup-title" number="01" title="Make the right starts" subtitle="Small lineup changes. More points on the board."/>{data.starts.length ? <div className="start-grid">{data.starts.map(decision => <StartCard key={decision.id} decision={decision} onReview={setAction}/>)}</div> : !connection ? <div className="surface"><EmptyState icon={<ListChecks/>} title="Start/sit analysis isn’t ready">Player projections and slot comparisons are needed before an advantage or confidence can be shown. Review your lineup alerts above.</EmptyState></div> : null}<LineupAnalysis {...lineup} section="lineup"/><p className="section-footnote"><Info size={13}/> Every projected advantage is your league&rsquo;s own scoring applied to a forecast source&rsquo;s raw statistics, never a generic projection. Review each checklist; changes are confirmed in Sleeper.</p></section>
    <section id="matchup" aria-labelledby="matchup-title"><SectionHeader id="matchup-title" number="02" title="Your matchup" subtitle="Know your edge. Plan for the swing."/><MatchupCard data={data}/><LineupAnalysis {...lineup} section="matchup"/></section></div>
    <div className="market-layout"><section id="waivers" aria-labelledby="waivers-title"><SectionHeader id="waivers-title" number="03" title="Find your next upgrade" subtitle="Waiver recommendations, ranked by roster fit and value."/><WaiverPlanner key={`${key}:${reload}`} leagueId={leagueId} userId={connection?.user.user_id} week={data.week} demo={data.demo} force={reload > 0} shared={connection ? { report: command?.sections.waivers.data ?? null, loading: busy, error: command?.sections.waivers.state === 'error' ? command.sections.waivers.warnings.join(' ') : error, recheck } : undefined}/></section>
    <section id="trades" aria-labelledby="trades-title"><SectionHeader id="trades-title" number="04" title="Build a stronger roster" subtitle="Your needs. A potential fit across the league."/><TradePlanner key={`${key}:${reload}`} leagueId={leagueId} userId={connection?.user.user_id} week={data.week} demo={data.demo} force={reload > 0} shared={connection ? { report: command?.sections.trades.data ?? null, loading: busy, error: command?.sections.trades.state === 'error' ? command.sections.trades.warnings.join(' ') : error, recheck, bounds, onBounds: setBounds } : undefined}/></section></div>
    <section id="league" aria-labelledby="league-title"><SectionHeader id="league-title" number="05" title="Keep a pulse on your league" subtitle="The standings, the moves, and what comes next.">{leagueUrl && <a className="text-link" href={leagueUrl} target="_blank" rel="noopener noreferrer">Open league <ExternalLink size={14}/><span className="sr-only"> in Sleeper (opens in a new tab)</span></a>}</SectionHeader><div className="league-grid"><div className="surface standings-surface"><div className="surface-heading"><h3><Trophy size={17}/> Standings</h3><span>{data.standings.length} teams</span></div>{data.standings.length ? <><div className="table-scroll" tabIndex={0} role="region" aria-label="League standings"><table className="standings-table"><caption className="sr-only">League standings ordered by record, then points for.</caption><thead><tr><th scope="col">Rank</th><th scope="col">Team</th><th scope="col">Record</th><th scope="col">Points for</th></tr></thead><tbody>{(fullStandings ? data.standings : data.standings.slice(0, 4)).map((team, index) => <tr key={team.id} className={team.isUser ? 'your-standing' : ''}><td>{index + 1}</td><td><strong>{team.name}</strong>{team.isUser && <span className="you-label">YOU</span>}</td><td>{team.wins}–{team.losses}{team.ties ? `–${team.ties}` : ''}</td><td>{number(team.points)}</td></tr>)}</tbody></table></div>{data.standings.length > 4 && <button className="standings-toggle" onClick={() => setFullStandings(v => !v)} aria-expanded={fullStandings}>{fullStandings ? 'Show top 4' : `View all ${data.standings.length} teams`}<ChevronDown size={15} className={fullStandings ? 'rotate' : ''}/></button>}</> : <EmptyState icon={<Trophy/>} title="Standings aren’t available">Standings will appear when league rosters and records are available.</EmptyState>}</div>
    <div className="surface activity-surface"><div className="surface-heading"><h3><Activity size={17}/> Recent activity</h3><span>Week {data.week}</span></div>{data.activity.length ? <ol className="activity-list">{data.activity.slice(0, 5).map(item => <li key={item.id}><span className={`activity-icon ${item.type === 'trade' ? 'trade' : ''}`}>{item.type === 'trade' ? <ArrowLeftRight size={16}/> : <Plus size={17}/>}</span><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={Number.isFinite(Date.parse(item.time)) ? item.time : undefined}>{data.demo ? item.time : item.time ? formattedTime(item.time) : 'Time unavailable'}</time></div></li>)}</ol> : <EmptyState icon={<Activity/>} title="A quiet week so far">No transactions were returned for this week. Check back after your league’s next waiver run.</EmptyState>}</div>
    <div className="playoff-card"><span className="eyebrow"><Flag size={16}/> THE ROAD AHEAD</span><h3>Playoff outlook</h3><div className="playoff-number">{data.playoffChance == null ? '—' : <>{data.playoffChance}<span>%</span></>}<small>{data.playoffChance == null ? 'Odds unavailable' : 'sample chance to qualify'}</small></div><p>{data.playoffNote}</p><div className="playoff-footer"><span>{rank != null && rank >= 0 ? `#${rank + 1} current rank` : 'Rank unavailable'}</span><span>{data.playoffSpots == null ? 'Spots unavailable' : `${data.playoffSpots} playoff spots`}</span></div></div></div></section>
    <div className="dashboard-footer"><span className="footer-brand">huddle.</span><p><ShieldCheck size={14}/> Every action is a recommendation until you confirm it in Sleeper.</p><span>{data.demo ? 'Sample league · No live data' : `Last successful sync: ${formattedTime(data.lastSyncedAt)}`}</span></div>
    </>}
    </main></div>{action && <ActionDialog key={`${key}:${action.id}`} action={action} leagueId={leagueId} demo={!connection} onClose={() => setAction(null)} onRetry={onRefresh} onConnect={onConnect}/>}</div>;
}
