import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpecialTeamsBreakdown } from '@sleeper/domain';
import { SpecialTeamsDetail } from './SpecialTeamsDetail';

const component = (category: SpecialTeamsBreakdown['components'][number]['category'], stat: string, teamStat: string, amount: number | null, rate: number | null, points: number, label: string) =>
  ({ category, label, stat, teamStat, amount, rate, modeled: amount !== null, scored: rate !== null && rate !== 0, points, explanation: `${label} explanation.` });

const partial: SpecialTeamsBreakdown = {
  entity: 'individual-player',
  components: [
    component('touchdowns', 'st_td', 'def_st_td', null, 6, 0, 'Return touchdowns'),
    component('forcedFumbles', 'st_ff', 'def_st_ff', .1, 1, .1, 'Special-teams forced fumbles'),
    component('fumbleRecoveries', 'st_fum_rec', 'def_st_fum_rec', .06, 2, .12, 'Special-teams fumble recoveries'),
  ],
  coverage: 'partial', uncovered: ['touchdowns'], undefinedRules: [],
  expectedPoints: .22, otherPoints: 0,
  returnRole: { kickReturns: 'primary', puntReturns: 'committee', expectedReturns: 3.5 },
  relevance: 'designated', rankingAdjustment: 0,
  uncertainty: ['Return touchdowns: not modeled by this forecast. Your league pays 6 per st_td.'],
  coverageNote: 'Incomplete special-teams coverage: this forecast does not model st_td.',
  explanation: '0.22 points from the modeled categories, with return touchdowns (st_td) not modeled.',
};

test('an unmodeled category reads as unknown, never as a zero or an invented bonus', () => {
  const html = renderToStaticMarkup(<SpecialTeamsDetail forecast={partial} context="Week 8"/>);
  assert.match(html, /Week 8: Special teams 0\.22 points/);
  assert.match(html, /Incomplete coverage/);
  assert.match(html, /Designated return role/);
  assert.match(html, /Not modeled/);
  // The league's own rate for the missing rule is shown, so it is never read as a zero rule.
  for (const stat of ['st_td', 'st_ff', 'st_fum_rec', 'def_st_td', 'def_st_ff', 'def_st_fum_rec']) assert.ok(html.includes(`<code>${stat}</code>`), stat);
  assert.match(html, /<strong>unknown, not zero<\/strong>/);
  assert.match(html, /no expected return touchdown is invented/);
  assert.match(html, /return upside adds 0 to every ranking/);
  assert.match(html, /Your league pays 6 per st_td/);
  // The two rule families are named as belonging to different entities, at different rates.
  assert.match(html, /never carries both, so a return touchdown is never scored twice/);
});

test('complete coverage states the modeled total without an incompleteness claim', () => {
  const complete: SpecialTeamsBreakdown = {
    ...partial, coverage: 'complete', uncovered: [], uncertainty: [], coverageNote: null,
    components: [component('touchdowns', 'st_td', 'def_st_td', .04, 6, .24, 'Return touchdowns'), ...partial.components.slice(1)],
    expectedPoints: .46, explanation: '0.46 points, every category this league pays for modeled by the forecast.',
  };
  const html = renderToStaticMarkup(<SpecialTeamsDetail forecast={complete}/>);
  assert.match(html, /Complete coverage/);
  assert.match(html, /every category this league pays for modeled/);
  assert.doesNotMatch(html, /unknown, not zero/);
  assert.doesNotMatch(html, /Not modeled/);
  // Nothing is rendered where the league scores no individual return rule, and nothing when absent.
  assert.equal(renderToStaticMarkup(<SpecialTeamsDetail forecast={{ ...complete, coverage: 'not-scored', expectedPoints: 0, otherPoints: 0 }}/>), '');
  assert.equal(renderToStaticMarkup(<SpecialTeamsDetail/>), '');
});
