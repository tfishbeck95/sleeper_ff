import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandCenterService } from '../../../api/src/command-center';
import { demoLineupInput } from '../../../api/src/test-support/scoring-fixtures';
import { loadCommandCenter } from './api';
import { fromCommandCenter } from './model';
import { CommandCenterStatus } from './CommandCenterStatus';
import { WaiverPlanner } from './WaiverPlanner';
import { TradePlanner } from './TradePlanner';

async function fixture() {
  const input = demoLineupInput();
  const service = new CommandCenterService({ dashboardContext: async () => ({ ...input, users: [], transactions: [], freshness: {} }) } as never,
    { syncLeague: async () => ({}) } as never, { load: async () => input.signals });
  return service.load({ id: 'app', login: 'owner', passwordHash: '', sleeperUserId: 'sample', sleeperLeagueIds: ['demo'], createdAt: '' }, 'demo', 8);
}

test('the coordinated query loads all sections in one authenticated, abortable request including trade bounds', async () => {
  const command = await fixture();
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(String(url), '/api/command-center/1234?week=8&maxValueGap=.4&maxRisk=.3');
      assert.equal(options?.credentials, 'include');
      assert.ok(options?.signal);
      return new Response(JSON.stringify(command));
    };
    const loaded = await loadCommandCenter('1234', 8, new AbortController().signal, { maxValueGap: '.4', maxRisk: '.3' });
    assert.equal(calls, 1);
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(command)));
    assert.equal(fromCommandCenter(loaded).scoring, loaded.sections.scoring.data);
    assert.deepEqual(fromCommandCenter(loaded).alerts.map(a => a.id).sort(), loaded.sections.alerts.data!.map(a => a.id).sort());
  } finally { globalThis.fetch = original; }
});

test('controlled panels render aggregated reports and errors without waiting for independent queries', async () => {
  const command = await fixture();
  const props = { leagueId: 'demo', week: 8, demo: false };
  const waiver = renderToStaticMarkup(<WaiverPlanner {...props} shared={{ report: command.sections.waivers.data, error: '', loading: false, recheck: () => {} }}/>);
  assert.doesNotMatch(waiver, /Checking league ownership/);
  assert.match(waiver, /Ranked add \/ drop pairs/);
  const trade = renderToStaticMarkup(<TradePlanner {...props} shared={{ report: null, error: 'Trade analysis failed.', loading: false, recheck: () => {}, bounds: { maxValueGap: '.4', maxRisk: '.3' }, onBounds: () => {} }}/>);
  assert.match(trade, /Trade analysis failed/);
  assert.doesNotMatch(trade, /Evaluating every roster/);
  assert.match(trade, /value=".4" selected/);
  const html = renderToStaticMarkup(<CommandCenterStatus command={command}/>);
  for (const [name, section] of Object.entries(command.sections)) assert.ok(html.includes(`${name}: ${section.state}`));
  assert.ok(html.includes(command.provenance.scoringSnapshotId!));
  assert.ok(html.includes(command.provenance.forecastUpdatedAt!));
});
