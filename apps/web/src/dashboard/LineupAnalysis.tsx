import { DefenseDetail } from './DefenseDetail';
import { KickerDetail } from './KickerDetail';
import { QuarterbackDetail } from './QuarterbackDetail';
import { useEffect, useState } from 'react';
import { ArrowUpDown, CalendarDays, Flag, ListChecks, RefreshCw, Shield, Target } from 'lucide-react';
import type { LineupReport } from '@sleeper/domain';
import { ScoringStatus } from './ScoringStatus';
import { ScoringBreakdown } from './ScoringBreakdown';
import { OpportunityDetail } from './OpportunityDetail';
import { request } from './api';

const points = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1);

export interface LineupState { report: LineupReport | null; loading: boolean; error: string; recheck: () => void }

/** Fetched once per league/week and shared by both sections, so one request serves both panels. */
export function useLineupReport({ leagueId, userId, week, demo, force = false }: { leagueId: string; userId?: string; week: number; demo: boolean; force?: boolean }): LineupState {
  const [report, setReport] = useState<LineupReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReport(null); setError('');
    const query = new URLSearchParams({ userId: userId ?? 'sample', week: String(week), force: String(force || retry > 0) });
    request<LineupReport>(`/api/lineup/${encodeURIComponent(demo ? 'demo' : leagueId)}?${query}`, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setReport(value); setLoading(false); } })
      .catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Lineup analysis failed.'); setLoading(false); } });
    return () => controller.abort();
  }, [leagueId, userId, week, demo, force, retry]);
  return { report, loading, error, recheck: () => setRetry(value => value + 1) };
}

/**
 * Renders lineup analysis whose every number is the selected league's scoring applied to a
 * provider's raw statistics. Nothing here accepts or displays a generic projected-points value:
 * each figure is shown with the sentence that produced it, and the contributions are one click away.
 */
export function LineupAnalysis({ report, loading, error, recheck, section }: LineupState & { section: 'lineup' | 'matchup' }) {
  if (loading) return <div className="surface lineup-analysis" aria-busy="true"><p role="status">Scoring your forecast source under this league’s rules…</p></div>;
  if (error) return <div className="surface lineup-analysis"><p role="alert">{error} No league-scored lineup analysis is available.</p><button className="secondary-button" onClick={recheck}><RefreshCw size={14}/> Try again</button></div>;
  if (!report) return null;
  const unavailable = report.status === 'unavailable';
  const heading = section === 'lineup'
    ? <span><ListChecks size={17}/> Start / sit under your league’s {report.scoringLabel} scoring</span>
    : <span><Target size={17}/> Matchup totals under your league’s {report.scoringLabel} scoring</span>;

  return <div className="surface lineup-analysis">
    <div className="waiver-planner-heading">{heading}<button className="secondary-button" onClick={recheck}><RefreshCw size={14}/> Recheck</button></div>
    {section === 'lineup' && <ScoringStatus scoring={report.scoring}/>}
    {unavailable
      ? <ul className="lineup-warnings">{report.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      : section === 'lineup' ? <>
        <p className="lineup-source">{report.forecast ? `${report.forecast.source} · Updated ${new Date(report.forecast.updatedAt).toLocaleString()}` : 'Forecast source unavailable'} · Scoring snapshot <code>{report.scoringSnapshotId}</code></p>
        <ol className="lineup-slots" aria-label="Submitted lineup">{report.lineup.map((slot, index) => <li key={`${slot.slot}:${index}`}>
          <span className="lineup-slot-name">{slot.slot}</span>
          <strong>{slot.player?.name ?? 'Empty'}</strong>
          <span className="lineup-slot-points">{points(slot.player?.scored.points)}</span>
          <span className="lineup-slot-range">{slot.explanation} {slot.player?.floorPoints == null ? 'No floor/ceiling stat scenario was supplied, so no range is shown.' : `Scored floor-to-ceiling range ${points(slot.player.floorPoints)}–${points(slot.player.ceilingPoints)}.`}</span>
          {slot.player && <ScoringBreakdown contributions={slot.player.scored.contributions} label={report.scoringLabel}/>}
          {slot.player && <><QuarterbackDetail outlook={slot.player.quarterback}/><KickerDetail forecast={slot.player.scored.kicker}/><DefenseDetail forecast={slot.player.scored.defense}/></>}
          {slot.player && <OpportunityDetail profile={slot.player.opportunity} compact/>}
        </li>)}</ol>
        {report.startSit.length ? <ol className="start-sit-list" aria-label="Start and sit recommendations">{report.startSit.map(decision => <li key={decision.id}>
          <article className="start-sit">
            <p className="start-sit-slot"><ArrowUpDown size={14}/> {decision.slot} · {decision.confidence} confidence</p>
            <h4>Start {decision.start.name} over {decision.sit.name}</h4>
            <p>{decision.explanation}</p>
            <ScoringBreakdown contributions={decision.start.scored.contributions} label={report.scoringLabel}/>
            <KickerDetail forecast={decision.start.scored.kicker} context={decision.start.name}/>
            <KickerDetail forecast={decision.sit.scored.kicker} context={decision.sit.name}/>
            <DefenseDetail forecast={decision.start.scored.defense} context={decision.start.name}/>
            <DefenseDetail forecast={decision.sit.scored.defense} context={decision.sit.name}/>
            {decision.start.quarterback && <div><strong>{decision.start.name}</strong><QuarterbackDetail outlook={decision.start.quarterback}/></div>}
            {decision.sit.quarterback && <div><strong>{decision.sit.name}</strong><QuarterbackDetail outlook={decision.sit.quarterback}/></div>}
            <OpportunityDetail profile={decision.start.opportunity}/>
            <ul className="start-sit-cautions">{decision.cautions.map(caution => <li key={caution}>{caution}</li>)}</ul>
          </article>
        </li>)}</ol> : <p className="lineup-empty">No bench player scores above an eligible starter under your league’s {report.scoringLabel} rules this week.</p>}
        <details className="lineup-strength"><summary><Shield size={14}/> Roster strength and replacement levels</summary>
          <ul>{report.rosterStrength.map(value => <li key={value.rosterId}><strong>{value.rosterName}</strong> — {value.projectedWeekly.explanation} {value.range.explanation}</li>)}</ul>
          <ul>{Object.entries(report.replacementLevels).map(([position, value]) => <li key={position}>{value.explanation}</li>)}</ul>
        </details>
        {report.rejected.length > 0 && <details className="lineup-rejections" open><summary>{report.rejected.length} refused projection(s) — excluded, never scored as zero</summary><ul>{report.rejected.map(value => <li key={`${value.playerId}:${value.kind}:${value.message}`}>{value.message}</li>)}</ul></details>}
        <p className="lineup-methodology">{report.methodology}</p>
      </> : <>
        <div className="lineup-matchup-totals">
          <div><strong>{points(report.matchup?.projectedFor.score)}</strong><span>you</span></div>
          <span className="score-dash">:</span>
          <div><strong>{points(report.matchup?.projectedAgainst.score)}</strong><span>{report.matchup?.opponentName ?? 'Opponent'}</span></div>
        </div>
        <p>{report.matchup?.projectedFor.explanation}</p>
        <p>{report.matchup?.projectedAgainst.explanation}</p>
        <p><strong>{report.matchup?.winProbability.value == null ? 'Win probability unavailable' : `${report.matchup.winProbability.value}% to win`}</strong> — {report.matchup?.winProbability.explanation}</p>
        <details className="lineup-outlook"><summary><CalendarDays size={14}/> Bye outlook for the remaining weeks</summary>
          <ul>{report.byeOutlook.map(value => <li key={value.week}>{value.explanation}</li>)}</ul>
        </details>
        <details className="lineup-outlook"><summary><Flag size={14}/> Playoff outlook</summary>
          {report.playoffOutlook
            ? <><p>{report.playoffOutlook.explanation}</p><ul>{report.playoffOutlook.risks.map(risk => <li key={risk}>{risk}</li>)}</ul></>
            : <p>No playoff schedule is configured for this league, so no playoff weeks can be scored.</p>}
        </details>
      </>}
  </div>;
}
