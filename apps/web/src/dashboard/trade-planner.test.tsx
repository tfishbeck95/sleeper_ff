import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TradePlanner, TradeReportView, TradeMessageEditor } from './TradePlanner';
import { buildTradeMessage } from './trade-message';
import { recommendTrades } from '../../../api/src/trades';
import { demoTradeInput } from '../../../api/src/test-support/scoring-fixtures';

test('trade panel renders values, both lineup changes, rationale, risks, fallbacks and editable messages', () => {
  const report = recommendTrades(demoTradeInput());
  const html = renderToStaticMarkup(<TradeReportView report={report} demo/>);
  for (const text of ['You deliver', 'You receive', 'Delivered', 'Received', 'Projected week lineup before and after', 'Why the other manager might accept', 'Primary risks', 'Less expensive fallback', 'Editable trade message', 'Copy message', 'Every roster’s needs', 'Neither is an acceptance probability']) assert.ok(html.includes(text), text);
  assert.match(html, /Roster 1 lineup comparison/); assert.match(html, /Roster 2 lineup comparison/);
  assert.match(html, /<textarea/); assert.doesNotMatch(html, /readonly|Send offer|likely to accept|confidence-badge/i);
});
test('message generator is concise, grounded in bilateral needs, and does not claim acceptance', () => {
  const offer = recommendTrades(demoTradeInput()).candidates[0];
  const friendly = buildTradeMessage(offer), direct = buildTradeMessage(offer, 'direct');
  assert.ok(friendly.length < 600); assert.ok(friendly.includes(offer.give[0].name)); assert.ok(friendly.includes(offer.receive[0].name));
  assert.match(friendly, /your WR/); assert.match(friendly, /my RB/); assert.notEqual(friendly, direct);
  assert.doesNotMatch(friendly, /likely|guaranteed|fair value|acceptance|\d+%/i);
  const html = renderToStaticMarkup(<TradeMessageEditor offer={offer}/>);
  assert.match(html, /Regenerate replaces your edits/); assert.match(html, /role="status"/);
});
test('loading, unavailable and no-cheaper-offer states remain honest and usable', () => {
  const loading = renderToStaticMarkup(<TradePlanner leagueId="1234" userId="me" week={8} demo={false}/>);
  assert.match(loading, /aria-busy="true"/); assert.doesNotMatch(loading, /Copy message|Fictional|Darius Bell/);
  const input = demoTradeInput(); input.signals = null;
  const unavailable = renderToStaticMarkup(<TradeReportView report={recommendTrades(input)} demo={false}/>);
  assert.match(unavailable, /Trade analysis is unavailable/); assert.doesNotMatch(unavailable, /Copy message/);
  const report = recommendTrades(demoTradeInput()); report.candidates = report.candidates.filter(c => !c.fallback);
  const noFallback = renderToStaticMarkup(<TradeReportView report={report} demo/>);
  assert.match(noFallback, /Less expensive fallback.*unavailable/); assert.match(noFallback, /No cheaper offer/);
});
