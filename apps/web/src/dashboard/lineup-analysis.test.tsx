import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXPECTED_SCORING, liveScoring } from '@sleeper/domain';
import type { LineupReport, OpportunityProfile, ScoredPoints } from '@sleeper/domain';
import { LineupAnalysis } from './LineupAnalysis';
import { ScoringBreakdown } from './ScoringBreakdown';
import { OpportunityDetail } from './OpportunityDetail';

const at = '2026-09-08T12:00:00Z';
const scored = (points: number): ScoredPoints => ({
  points, explanation: `${points.toFixed(1)} points under your league's full-PPR scoring`,
  breakdown: `${points * 5} rec_yd × 0.1 = ${(points / 2).toFixed(2)}; ${points / 2} rec × 1 = ${(points / 2).toFixed(2)}`,
  contributions: [{ stat: 'rec_yd', amount: points * 5, rate: .1, points: points / 2 }, { stat: 'rec', amount: points / 2, rate: 1, points: points / 2 }],
});
const profile = (overrides: Partial<OpportunityProfile> = {}): OpportunityProfile => ({
  targets: 9.2, targetsPerRouteRun: .287, routeParticipation: .88, targetShare: .24, redZoneTargets: 1.8,
  receptionPoints: 6, receptionShare: .5, touchdownShare: 0, archetype: 'volume-driven', passCatchingBack: false,
  stability: .922, trend: .5, floorLift: .211,
  explanation: '9.2 projected targets per week on 0.287 targets per route run; 88% route participation. Volume-driven: receptions and receiving yardage carry the projection.',
  receptionExplanation: "6 of 12 points come from receptions at 1 per catch: 50% of the total. Under non-PPR scoring the same stat line projects 6. Your league's full-PPR scoring is specifically what elevates this value.",
  ...overrides,
});
const view = (name: string, points: number, opportunity: OpportunityProfile | null = profile()) => ({ playerId: name, name, positions: ['WR'], team: 'SEA', scored: scored(points), floorPoints: points * .7, ceilingPoints: points * 1.3, bye: false, injuryStatus: null, opportunity });
const report = (overrides: Partial<LineupReport> = {}): LineupReport => ({
  leagueId: '1234', rosterId: 1, week: 8, season: '2026', generatedAt: at, status: 'ready',
  scoring: liveScoring({ ...EXPECTED_SCORING }, at), scoringSnapshotId: 'complete-live:2026-09-08T12:00:00Z:abcdef01', scoringLabel: 'full-PPR',
  forecast: { source: 'Test forecasts', updatedAt: at }, warnings: [], rejected: [],
  lineup: [{ slot: 'WR', player: view('Marcus Reed', 15.8), explanation: "Marcus Reed fills WR with 15.8 points under your league's full-PPR scoring." }],
  optimal: [{ slot: 'WR', player: view('Jordan Cole', 18.4), explanation: 'Optimal WR.' }],
  bench: [view('Jordan Cole', 18.4)],
  startSit: [{ id: 'WR:cole', slot: 'WR', start: view('Jordan Cole', 18.4), sit: view('Marcus Reed', 15.8), advantage: 2.6, explanation: "Jordan Cole scores 18.4 points under your league's full-PPR scoring, 2.6 more than Marcus Reed's 15.8 in WR.", confidence: 'medium', cautions: ['Confirm both players are unlocked.'] }],
  matchup: {
    opponentRosterId: 2, opponentName: 'Gridiron Guild',
    projectedFor: { score: 126.8, explanation: "Your submitted lineup scores 126.8 points: this league's full-PPR rules applied to each starter's raw stat forecast." },
    projectedAgainst: { score: 119.4, explanation: "Gridiron Guild's submitted lineup scores 119.4 points." },
    margin: { score: 7.4, explanation: 'Both totals are submitted lineups scored under the same rules.' },
    winProbability: { value: 58.2, explanation: 'A 7.4-point league-scored margin against a combined 12-point standard deviation.' },
  },
  rosterStrength: [], replacementLevels: { WR: { score: 8.2, explanation: "WR replacement level scores 8.2 points under your league's full-PPR scoring." } },
  byeOutlook: [{ week: 8, bye: false, playoff: false, startersOnBye: [], fillableSlots: 1, requiredSlots: 1, projected: 126.8, explanation: 'Week 8: 1/1 starting slots fillable.' }],
  playoffOutlook: { weeks: [15, 16], projected: 118.2, explanation: 'Playoff weeks 15, 16 average 118.2 points.', risks: ['Availability can still change.'] },
  methodology: 'Forecast providers supply raw projected statistics.', ...overrides,
});

const noop = () => {};

test('the scoring breakdown discloses the statistics and rates behind a league-scored total', () => {
  const html = renderToStaticMarkup(<ScoringBreakdown contributions={scored(18.4).contributions} label="full-PPR" context="the week 8 stat line"/>);
  assert.match(html, /How your league(&#x27;|’)s full-PPR scoring produced 18\.4 points from the week 8 stat line/);
  assert.match(html, /rec_yd/); assert.match(html, /9\.20/);
  assert.match(html, /<th scope="col">Your rate<\/th>/);
  const empty = renderToStaticMarkup(<ScoringBreakdown contributions={[]} label="full-PPR"/>);
  assert.match(empty, /zero rather than unknown/);
  const many = renderToStaticMarkup(<ScoringBreakdown contributions={Array.from({ length: 8 }, (_, i) => ({ stat: `s${i}`, amount: 1, rate: 1, points: 1 }))} label="half-PPR"/>);
  assert.match(many, /3 smaller contribution\(s\)/);
});

test('lineup analysis states the scoring behind every figure and exposes contributions on demand', () => {
  const panel = renderToStaticMarkup(<LineupAnalysis report={report()} loading={false} error="" recheck={noop} section="lineup"/>);
  assert.match(panel, /Start \/ sit under your league(&#x27;|’)s full-PPR scoring/);
  assert.match(panel, /Marcus Reed fills WR with 15\.8 points under your league(&#x27;|’)s full-PPR scoring/);
  assert.match(panel, /Start Jordan Cole over Marcus Reed/);
  assert.match(panel, /How your league(&#x27;|’)s full-PPR scoring produced 18\.4 points/);
  assert.match(panel, /complete-live:2026-09-08T12:00:00Z:abcdef01/);
  const matchup = renderToStaticMarkup(<LineupAnalysis report={report()} loading={false} error="" recheck={noop} section="matchup"/>);
  assert.match(matchup, /58\.2% to win/);
  assert.match(matchup, /Playoff weeks 15, 16 average 118\.2 points/);
  // Nothing is rendered before a report exists, and refusals are surfaced rather than hidden.
  assert.match(renderToStaticMarkup(<LineupAnalysis report={null} loading error="" recheck={noop} section="lineup"/>), /Scoring your forecast source/);
  const refused = renderToStaticMarkup(<LineupAnalysis report={report({ status: 'partial', rejected: [{ playerId: 'x', kind: 'units', message: 'Ghost: week 8 supplies "targets", which this league\'s scoring rules do not define.' }] })} loading={false} error="" recheck={noop} section="lineup"/>);
  assert.match(refused, /1 refused projection\(s\) — excluded, never scored as zero/);
  assert.match(refused, /scoring rules do not define/);
  const unavailable = renderToStaticMarkup(<LineupAnalysis report={report({ status: 'unavailable', warnings: ['Validated complete live scoring is required.'] })} loading={false} error="" recheck={noop} section="lineup"/>);
  assert.match(unavailable, /Validated complete live scoring is required/);
  assert.doesNotMatch(unavailable, /15\.8/);
});

test('a rendered lineup report never shows a bare projection without its league scoring', () => {
  const value = report();
  const rendered = [
    ...value.lineup.map(slot => slot.explanation),
    ...value.startSit.map(decision => decision.explanation),
    value.matchup!.projectedFor.explanation,
    ...Object.values(value.replacementLevels).map(level => level.explanation),
  ];
  for (const sentence of rendered) assert.match(sentence, /full-PPR|same rules/);
  assert.ok(value.startSit.every(decision => decision.start.scored.contributions.length));
});

test('receiving opportunity is shown as workload context, never as added value', () => {
  const html = renderToStaticMarkup(<OpportunityDetail profile={profile({ passCatchingBack: true })}/>);
  assert.match(html, /Volume-driven/);
  assert.match(html, /Pass-catching back/);
  assert.match(html, /Floor lifted 21%/);
  assert.match(html, /Targets per route run/); assert.match(html, /0\.287/);
  assert.match(html, /Route participation/); assert.match(html, /88%/);
  assert.match(html, /Red-zone targets/);
  assert.match(html, /Reception points<\/dt><dd>6 \(50% of the total\)/);
  assert.match(html, /Target stability<\/dt><dd>0\.922 of 1/);
  assert.match(html, /Recent target trend<\/dt><dd>\+0\.5 per game/);
  assert.match(html, /full-PPR scoring is specifically what elevates this value/);
  assert.match(html, /Opportunity is workload, not scoring/);
  // A touchdown-dependent receiver is labelled as such, and an absent profile renders nothing.
  assert.match(renderToStaticMarkup(<OpportunityDetail profile={profile({ archetype: 'touchdown-dependent' })}/>), /Touchdown-dependent/);
  assert.equal(renderToStaticMarkup(<OpportunityDetail profile={null}/>), '');
  // Measures the provider did not supply are omitted rather than shown as zero.
  const sparse = renderToStaticMarkup(<OpportunityDetail profile={profile({ targetsPerRouteRun: null, redZoneTargets: null, stability: null, trend: null })}/>);
  assert.doesNotMatch(sparse, /Targets per route run|Red-zone targets|Target stability|Recent target trend/);
});
