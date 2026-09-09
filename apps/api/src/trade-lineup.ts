import type { RosterRules, TradeLineup } from '@sleeper/domain';

export interface LineupPlayer { id: string; name: string; positions: string[]; points: number }
/** Rectangular Hungarian assignment. Dummy columns expose empty slots; cardinality precedes points.
 * Unlike greedy slot filling, this is exact for overlapping flex and multi-position eligibility. */
export function optimizeTradeLineup(pool: LineupPlayer[], rules: RosterRules): TradeLineup {
  const n = rules.starters.length, m = pool.length + n;
  const reward = 1 + 2 * n * Math.max(1, ...pool.map(p => Math.abs(p.points)));
  const cost = rules.starters.map(slot => Array.from({ length: m }, (_, j) => j >= pool.length ? 0
    : pool[j].positions.some(p => rules.eligiblePositions(slot.position).includes(p)) ? -reward - pool[j].points : reward * (n + 1)));
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const min = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < min[j]) { min[j] = cur; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const prior = way[j0]; p[j0] = p[prior]; j0 = prior; } while (j0 !== 0);
  }
  const assigned = Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assigned[p[j] - 1] = j - 1;
  const slots = rules.starters.map((slot, i) => {
    const player = pool[assigned[i]];
    return { slot: slot.position, playerId: player?.id ?? null, name: player?.name ?? 'Empty slot', points: player?.points ?? 0 };
  });
  return { legal: slots.every(s => s.playerId !== null), points: Math.round(slots.reduce((sum, s) => sum + s.points, 0) * 100) / 100, slots };
}
