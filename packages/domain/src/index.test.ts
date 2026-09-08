import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreStartDecision } from './index.js';
test('scoreStartDecision rewards upward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'up' }), 15.7));
test('scoreStartDecision discounts downward trends', () => assert.equal(scoreStartDecision({ projectedPoints: 14.2, trend: 'down' }), 13.2));
