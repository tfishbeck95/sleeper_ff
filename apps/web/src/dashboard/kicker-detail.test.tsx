import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { KICKER_DISTANCE_BANDS, type KickerBreakdown, type KickerStreamerProfile } from '@sleeper/domain';
import { KickerDetail } from './KickerDetail';

const forecast: KickerBreakdown = {
  distances: KICKER_DISTANCE_BANDS.map(band => ({ band, attempts: .5, makes: .4, misses: .1, makePoints: 1.2, missPoints: -.1 })),
  expectedAttempts: 3, expectedMakes: 2.4, expectedMisses: .6, longAttemptProbability: .6, accuracy: .8,
  patMakes: 2, patMisses: .1, patPoints: 1.9, fieldGoalMissPoints: -.6, patMissPoints: -.1,
  missDownside: .7, expectedPoints: 10.9, context: null, explanation: 'Expected miss deductions included.',
};
test('kicker disclosure shows all distance categories, PATs, expected points and deductions', () => {
  const html = renderToStaticMarkup(<KickerDetail forecast={forecast} context="Week 8"/>);
  for (const label of ['0–19 yards', '20–29 yards', '30–39 yards', '40–49 yards', '50–59 yards', '60+ yards', 'PAT']) assert.ok(html.includes(label));
  assert.match(html, /10\.90 expected points/); assert.match(html, /Miss downside 0\.70 pts already deducted/);
  assert.match(html, /80\.0% expected accuracy/); assert.match(html, /60\.0% chance of a 50\+ yard attempt/);
  assert.match(html, /not a worst-case floor/);
  assert.equal(renderToStaticMarkup(<KickerDetail/>), '');
});
test('streamer preferences disclose context coverage and stay separate from points', () => {
  const profile: KickerStreamerProfile = { forecast, rankingAdjustment: -.4, factors: [{ label: 'Stadium and weather', value: -.4, explanation: '30 mph wind at Test field.' }], missingContext: ['Licensed game script and implied scoring unavailable; no market input used.'] };
  const html = renderToStaticMarkup(<KickerDetail profile={profile}/>);
  assert.match(html, /Streamer ranking adjustment: -0\.40/);
  assert.match(html, /30 mph wind/); assert.match(html, /Licensed game script and implied scoring unavailable/);
  assert.match(html, /10\.90 expected points/);
  const out = renderToStaticMarkup(<KickerDetail forecast={{ ...forecast, expectedPoints: 0, missDownside: 0, availabilityNote: 'Week 8 is a bye; counts are before availability.' }}/>);
  assert.match(out, /Week 8 is a bye/);
});
