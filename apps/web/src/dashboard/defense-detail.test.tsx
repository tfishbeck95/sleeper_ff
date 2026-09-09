import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  POINTS_ALLOWED_BUCKETS, YARDS_ALLOWED_BUCKETS,
  type DefenseBreakdown, type DefenseStreamerProfile,
} from '@sleeper/domain';
import { DefenseDetail } from './DefenseDetail';

const forecast: DefenseBreakdown = {
  components: [
    { label: 'Sacks', stat: 'sack', amount: 2.5, rate: 1, points: 2.5 },
    { label: 'Interceptions', stat: 'int', amount: .8, rate: 2, points: 1.6 },
    { label: 'Forced fumbles', stat: 'ff', amount: .9, rate: 1, points: .9 },
    { label: 'Fumble recoveries', stat: 'fum_rec', amount: .6, rate: 1, points: .6 },
    { label: 'Defensive touchdowns', stat: 'def_td', amount: .25, rate: 6, points: 1.5 },
    { label: 'Special-teams touchdowns', stat: 'def_st_td', amount: .05, rate: 6, points: .3 },
  ],
  pointsAllowed: {
    shutoutProbability: .06, expected: null, expectedPoints: .48,
    tiers: POINTS_ALLOWED_BUCKETS.map((bucket, index) => ({ bucket, stat: `pts_allow_${bucket}`, probability: index === 0 ? .06 : .1, rate: index === 0 ? 8 : 0, points: index === 0 ? .48 : 0 })),
    explanation: '6% chance of a shutout earns 0.48 of the 8-point bonus.',
  },
  yardsAllowed: {
    under100Probability: .04, expected: null, expectedPoints: .12,
    tiers: YARDS_ALLOWED_BUCKETS.map((bucket, index) => ({ bucket, stat: `yds_allow_${bucket}`, probability: index === 0 ? .04 : .1, rate: index === 0 ? 3 : 0, points: index === 0 ? .12 : 0 })),
    explanation: '4% chance of under 100 yards earns 0.12 of the 3-point bonus.',
  },
  pressurePoints: 2.5, turnoverPoints: 3.1, touchdownPoints: 1.5, situationalPoints: .3,
  specialTeamsPoints: .55, thresholdPoints: .6, otherPoints: 0, expectedPoints: 8.55,
  drivers: [{ label: 'Sacks', points: 2.5, explanation: '2.5 × 1 = 2.5 points.' }],
  context: null, explanation: '8.55 expected points.',
};

test('defense disclosure names every raw category, its Sleeper rule and both tier distributions', () => {
  const html = renderToStaticMarkup(<DefenseDetail forecast={forecast} context="Week 8"/>);
  for (const label of ['Sacks', 'Interceptions', 'Forced fumbles', 'Fumble recoveries', 'Defensive touchdowns', 'Special-teams touchdowns']) assert.ok(html.includes(label), label);
  for (const label of ['Shutout', '35+ points', 'Under 100 yards', '550+ yards']) assert.ok(html.includes(label), label);
  for (const stat of ['sack', 'ff', 'fum_rec', 'def_td', 'def_st_td', 'pts_allow_0', 'yds_allow_0_100']) assert.ok(html.includes(`<code>${stat}</code>`), stat);
  assert.match(html, /8\.55 expected points/);
  assert.match(html, /6\.0% shutout chance/);
  assert.match(html, /4\.0% chance of under 100 yards allowed/);
  // The two failure modes this contract exists to prevent are stated where a manager reads the number.
  assert.match(html, /separate Sleeper events/);
  assert.match(html, /without paying the whole bonus/);
  assert.equal(renderToStaticMarkup(<DefenseDetail/>), '');
});

test('streamer preferences disclose missing context and stay separate from points', () => {
  const profile: DefenseStreamerProfile = {
    forecast, rankingAdjustment: .33,
    factors: [{ label: 'Opponent starting quarterback', value: .3, explanation: 'Opponent quarterback is designated backup.' }],
    missingContext: ['Licensed game script and implied opponent scoring unavailable; no market input used.'],
  };
  const html = renderToStaticMarkup(<DefenseDetail profile={profile}/>);
  assert.match(html, /Streamer ranking adjustment: \+0\.33/);
  assert.match(html, /designated backup/);
  assert.match(html, /Licensed game script and implied opponent scoring unavailable/);
  assert.match(html, /change priority, not expected fantasy points/);
  assert.match(html, /8\.55 expected points/);
  const out = renderToStaticMarkup(<DefenseDetail forecast={{ ...forecast, expectedPoints: 0, availabilityNote: 'Week 8 is a bye; counts are before availability.' }}/>);
  assert.match(out, /Week 8 is a bye/);
  assert.match(out, /0\.00 expected points/);
});
