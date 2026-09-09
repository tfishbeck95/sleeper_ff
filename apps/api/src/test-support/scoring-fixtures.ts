import { EXPECTED_SCORING, liveScoring } from '@sleeper/domain';
import { demoWaiverInput as sampleWaivers } from '../waiver-demo.js';
import { demoTradeInput as sampleTrades } from '../trade-demo.js';

// Simulate a validated upstream response for ranking tests; production samples remain partial references.
export function demoWaiverInput(...args: Parameters<typeof sampleWaivers>) {
  const input = sampleWaivers(...args);
  input.league.scoring = liveScoring({ ...EXPECTED_SCORING }, input.league.synchronizedAt);
  return input;
}
export function demoTradeInput(...args: Parameters<typeof sampleTrades>) {
  const input = sampleTrades(...args);
  input.league.scoring = liveScoring({ ...EXPECTED_SCORING }, input.league.synchronizedAt);
  return input;
}
