import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Info, ListChecks, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Confidence } from './components';
import { sleeperLeagueUrl } from './model';
import type { ProposedAction } from './types';

export function ActionDialog({ action, leagueId, demo, onClose, onRetry, onConnect }: {
  action: ProposedAction; leagueId: string; demo: boolean; onClose: () => void; onRetry: () => void; onConnect: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [opened, setOpened] = useState(false);
  const url = demo ? null : sleeperLeagueUrl(leagueId);
  const complete = checked.length === action.checklist.length;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const destination = action.kind === 'waiver' ? 'Players, then find the target and review an add or waiver claim' : action.kind === 'trade' ? 'the trade partner’s roster, then review the players and picks in an offer' : 'your team, then review your starters and player status';
  return <dialog ref={ref} className="action-dialog" aria-labelledby="action-title" aria-describedby="action-reason" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-top"><span className="eyebrow"><ListChecks size={16}/> REVIEW YOUR GAME PLAN</span><button autoFocus className="icon-button" aria-label="Close recommendation" onClick={onClose}><X size={20}/></button></div>
    <h2 id="action-title">{action.title}</h2>
    <div className="dialog-badges"><span className="status">Recommendation · Not confirmed</span>{demo && <span className="status sample">Fictional sample</span>}{action.confidence != null && <Confidence value={action.confidence}/>}</div>
    <p id="action-reason">{action.reason}</p>
    {action.caution && <div className="caution-note"><Info size={18}/><span>{action.caution}</span></div>}
    {action.confidence != null && <p className="checklist-help">{demo ? 'This confidence score is illustrative. It describes the strength of the recommendation, not the probability of winning.' : 'Confidence describes the strength of the recommendation, not a guarantee of points or a win.'}</p>}
    <div className="checklist-heading"><h3>Before you act</h3><span>{checked.length} of {action.checklist.length} reviewed</span></div>
    <p className="checklist-help">Check each item as you review it. This checklist does not submit or confirm a change.</p>
    <fieldset className="action-checklist"><legend className="sr-only">Recommendation checklist</legend>{action.checklist.map((item, index) => <label key={item} className={checked.includes(index) ? 'checked' : ''}><input type="checkbox" checked={checked.includes(index)} onChange={event => setChecked(items => event.target.checked ? [...items, index] : items.filter(i => i !== index))}/><span>{item}</span></label>)}</fieldset>
    <p className="review-status" role="status"><Check size={16}/>{complete ? 'Checklist reviewed. This is still an unconfirmed recommendation.' : 'Review is in progress. No changes have been made.'}</p>
    <div className="dialog-boundary"><ShieldCheck size={18}/><span>Huddle is read-only. Every lineup change, claim, and trade must be reviewed and confirmed by you in Sleeper.</span></div>
    <div className="dialog-footer">
      {action.kind === 'sync' && <button className="button" onClick={() => { onRetry(); onClose(); }}><RefreshCw size={16}/>{demo ? 'Reload sample' : 'Retry sync'}</button>}
      {url ? <><a className="button" href={url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>Open league in Sleeper <ExternalLink size={16}/><span className="sr-only"> (opens in a new tab)</span></a><p>In Sleeper, open {destination}. The link opens your league; it does not prefill or submit an action.</p></> : <><button className="button" onClick={() => { onClose(); onConnect(); }}>Connect your Sleeper league</button><p>{demo ? 'Sample recommendations have no live league destination.' : 'A valid league link is unavailable. Open your league in Sleeper manually.'}</p></>}
      {opened && <p role="status">Sleeper opened in a new tab. Huddle cannot verify whether you confirmed this recommendation there.</p>}
    </div>
  </dialog>;
}
