import type { WaiverHorizon, WaiverNeed, WaiverRecommendation, WaiverReport, WaiverRisk } from '@sleeper/domain';

export const horizonLabels: Record<WaiverHorizon, string> = { streamer: 'Immediate streamers', 'rest-of-season': 'Rest of season', dynasty: 'Dynasty stashes' };
export const needLabels: Record<WaiverNeed, string> = { 'starter-upgrade': 'Starter upgrade', 'bye-cover': 'Bye cover', 'injury-cover': 'Injury cover', 'bench-depth': 'Bench depth', stash: 'Future stash' };
export interface WaiverFilters { position: string; horizon: WaiverHorizon | 'all'; risk: WaiverRisk | 'all'; need: WaiverNeed | 'all' }
export const defaultWaiverFilters: WaiverFilters = { position: 'all', horizon: 'all', risk: 'all', need: 'all' };
export function filterWaivers(rows: WaiverRecommendation[], filters: WaiverFilters) {
  return rows.filter(r => (filters.position === 'all' || r.add.positions.includes(filters.position)) && (filters.horizon === 'all' || r.horizon === filters.horizon) && (filters.risk === 'all' || r.risk === filters.risk) && (filters.need === 'all' || r.need === filters.need)).sort((a, b) => a.priority - b.priority);
}

/** Shared drops are conditional fallback claims; a player can appear only once in an executable plan. */
export function buildWaiverPlan(report: WaiverReport, rows: WaiverRecommendation[]) {
  const usedAdds = new Set<string>();
  const selected = [...rows].sort((a, b) => a.priority - b.priority).filter(r => {
    if (usedAdds.has(r.add.id)) return false;
    usedAdds.add(r.add.id); return true;
  });
  const lines = [`${report.leagueId === 'demo' ? 'FICTIONAL SAMPLE — ' : ''}Waiver plan · Week ${report.week} · League ${report.leagueId}`, `Forecasts: ${report.source?.name ?? 'unavailable'} (${report.source?.updatedAt ?? 'unknown'}). Roster snapshot: ${report.rosterSyncedAt}.`, ''];
  const groupReserves = new Map<string, number>();
  const groups = new Map<string, number>();
  const budgets = selected.flatMap(r => r.faab ? [r.faab.remaining] : []);
  let remaining = budgets.length ? Math.min(...budgets) : null;
  let count = 0;
  for (const r of selected) {
    // Conservatively use just one open slot, with alternatives, even if several slots are free.
    const group = r.drop?.id ?? 'open-slot';
    const firstPriority = groups.get(group);
    let bid = '';
    if (r.faab && remaining !== null) {
      const groupBudget = firstPriority ? groupReserves.get(group)! : remaining;
      const maximum = Math.min(r.faab.max, groupBudget);
      if (maximum < r.faab.min) continue;
      if (!firstPriority) {
        const reserve = Math.min(remaining, Math.max(...selected.filter(v => (v.drop?.id ?? 'open-slot') === group).map(v => v.faab?.max ?? 0)));
        groupReserves.set(group, reserve); remaining -= reserve;
      }
      bid = ` Bid $${r.faab.min}–$${maximum}${maximum < r.faab.max ? ' (capped to fit plan budget)' : ''}.`;
    }
    count += 1;
    if (!firstPriority) groups.set(group, count);
    lines.push(`${count}. ADD ${r.add.name} (${r.add.positions.join('/')}) → ${r.drop ? `DROP ${r.drop.name}` : 'use open active slot'}.${bid} ${horizonLabels[r.horizon]}; ${needLabels[r.need]}; ${r.risk} risk.${firstPriority ? ` Fallback to #${firstPriority}: only if that add and earlier alternatives using this drop/slot fail.` : ''}`);
    if (r.kicker) lines.push(`   ${r.kicker.forecast.explanation}`);
    if (r.faab) lines.push(`   ${r.faab.explanation}`);
  }
  if (!count) lines.push('No selected claims fit the available evidence and budget.');
  lines.push('', 'Each shared drop/open slot is one group of alternatives: at most one addition per group. Duplicate player horizons are merged. Choose one bid per claim; upper ranges reserve budget across independent groups. Claims below their minimum affordable bid are omitted.', 'Pairs are evaluated independently. Recheck positional limits and starter coverage if multiple groups may succeed.', 'Refresh availability and check locks, $0 bid rules, balances, deadlines, and the exact add/drop order in Sleeper.', report.submission.instruction);
  return lines.join('\n');
}
