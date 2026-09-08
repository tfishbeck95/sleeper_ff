import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WaiverRecommendation, WaiverReport } from '@sleeper/domain';
import { buildWaiverPlan, defaultWaiverFilters, filterWaivers } from './waiver-plan';
import { WaiverPlanner } from './WaiverPlanner';

const player = (id: string) => ({ id, name: id, positions: ['RB', 'WR'], team: 'ABC' });
const row = (id: string, priority: number, drop = 'Bench A'): WaiverRecommendation => ({ id, priority, add: player(id), drop: player(drop), horizon: 'streamer', risk: 'low', need: 'bye-cover', score: 10, projectedPoints: 12, starterGain: 12, benchGain: 8, starterComparison: null, weakestBench: player(drop), dropCost: 4, dropReason: 'Weakest bench', upcoming: [], playoffPoints: null, reasons: [], uncertainty: [], faab: { min: 5, max: 10, remaining: 15, urgency: 'high', explanation: 'High urgency. Rival bids unknown.' } });
const report = (): WaiverReport => ({ leagueId: '1234', rosterId: 1, week: 8, season: '2026', generatedAt: '2026-09-08T12:00:00Z', rosterSyncedAt: '2026-09-08T12:00:00Z', source: { name: 'Test forecasts', updatedAt: '2026-09-08T12:00:00Z' }, status: 'ready', warnings: [], rosteredCount: 10, eligibleCount: 3, evaluatedCount: 3, recommendations: [], submission: { supported: false, url: 'https://sleeper.com/leagues/1234', instruction: 'Submit claims manually in Sleeper. No claims have been submitted.' } });

test('all four filters intersect, include multi-position eligibility, and preserve API priority', () => {
  const rows = [row('B', 2), row('A', 1), { ...row('C', 3), risk: 'high' as const, horizon: 'dynasty' as const, need: 'stash' as const }];
  const filtered = filterWaivers(rows, { position: 'WR', horizon: 'streamer', risk: 'low', need: 'bye-cover' });
  assert.deepEqual(filtered.map(r => r.id), ['A', 'B']); assert.equal(rows[0].id, 'B');
  assert.deepEqual(filterWaivers(rows, { ...defaultWaiverFilters, position: 'QB' }), []);
  assert.deepEqual(filterWaivers(rows, { ...defaultWaiverFilters, need: 'stash' }).map(r => r.id), ['C']);
});

test('priority plans deduplicate horizons and make shared drops conditional fallback claims', () => {
  const a = row('A', 1);
  const text = buildWaiverPlan(report(), [row('B', 3), { ...a, id: 'A:dynasty', priority: 2, horizon: 'dynasty' }, a]);
  assert.equal((text.match(/ADD A /g) ?? []).length, 1);
  assert.match(text, /1\. ADD A/); assert.match(text, /2\. ADD B/); assert.match(text, /Fallback to #1/);
  assert.match(text, /No claims have been submitted/);
});

test('independent claims reserve the largest alternative bid per drop and respect total FAAB', () => {
  const a = row('A', 1); a.faab!.max = 12;
  const b = row('B', 2, 'Bench B'); b.faab!.min = 2;
  const c = row('C', 3); c.faab!.max = 14;
  const text = buildWaiverPlan(report(), [a, b, c]);
  assert.match(text, /ADD A/); assert.doesNotMatch(text, /ADD B/); assert.match(text, /ADD C/);
  const capped = buildWaiverPlan(report(), [row('A', 1), row('B', 2, 'Bench B')]);
  assert.match(capped, /\$5–\$5 \(capped to fit plan budget\)/);
});

test('open-slot claims are alternatives, $0 bids stay zero, and selected rows alone are copied', () => {
  const a = { ...row('A', 1), drop: null, faab: { ...row('A', 1).faab!, min: 0, max: 0, remaining: 0 } };
  const b = { ...a, id: 'B', add: player('B'), priority: 2 };
  const text = buildWaiverPlan(report(), [a, b]);
  assert.match(text, /use open active slot/); assert.match(text, /Fallback to #1/); assert.match(text, /Bid \$0–\$0/);
  assert.doesNotMatch(buildWaiverPlan(report(), [a]), /ADD B/);
  assert.match(buildWaiverPlan(report(), []), /No selected claims/);
});

test('waiver panel starts with accessible loading, without a misleading active copy or submit control', () => {
  const html = renderToStaticMarkup(<WaiverPlanner leagueId="1234" userId="me" week={8} demo={false}/>);
  assert.match(html, /aria-busy="true"/); assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Copy priority plan|Submit in Sleeper/);
});
