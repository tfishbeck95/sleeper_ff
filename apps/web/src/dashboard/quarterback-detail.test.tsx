import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuarterbackBreakdown } from '@sleeper/domain';
import { QuarterbackDetail } from './QuarterbackDetail';

const mean: QuarterbackBreakdown = {
  passingTouchdowns: { stat: 'pass_td', amount: 2, rate: 4, points: 8 },
  passingYards: { stat: 'pass_yd', amount: 250, rate: .04, points: 10 },
  interceptions: { stat: 'pass_int', amount: 1, rate: -2, points: -2 },
  rushingYards: { stat: 'rush_yd', amount: 40, rate: .1, points: 4 },
  rushingTouchdowns: { stat: 'rush_td', amount: 0, rate: 6, points: 0 },
  designedRuns: [{ stat: 'rush_yd', amount: 25, rate: .1, points: 2.5 }], scrambles: null,
  otherPoints: 0, totalPoints: 20, rushingPoints: 4, turnoverPoints: -2, multiplier: 1, explanation: '',
};
test('QB disclosure shows all components, zero TDs, optional subsets and independently missing scenarios', () => {
  const html = renderToStaticMarkup(<QuarterbackDetail outlook={{ mean, floor: null, ceiling: mean, adjustments: [] }}/>);
  for (const label of ['Passing touchdown points', 'Passing yardage points', 'Interception deductions', 'Rushing yardage points', 'Rushing touchdown points', 'Designed-run contribution', 'Scramble contribution', 'Mean', 'Floor', 'Ceiling']) assert.ok(html.includes(label), label);
  assert.match(html, /0.00 \(0 × 6\)/);
  assert.match(html, /Not supplied/);
  assert.match(html, /Projected turnovers cost 2.00/);
  assert.match(html, /Rushing contributes 4.00/);
  assert.match(html, /already included/);
  assert.equal(renderToStaticMarkup(<QuarterbackDetail/>), '');
});
test('QB adjusted component arithmetic discloses the multiplier', () => {
  const html = renderToStaticMarkup(<QuarterbackDetail outlook={{ mean: { ...mean, multiplier: 0 }, floor: null, ceiling: null, adjustments: ['Bye week zeroes the score.'] }}/>);
  assert.match(html, /post-scoring multiplier 0.000/);
  assert.match(html, /Bye week zeroes the score/);
});
