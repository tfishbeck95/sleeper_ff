import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TIME_ZONE, DEFAULT_WINDOWS, IngestionSchedule, localTime, nextRun } from './schedule.js';
import type { ProjectionIngestionService } from './ingest.js';
import type { IngestionReport } from './service-level.js';

const local = (date: Date) => localTime(date, DEFAULT_TIME_ZONE);
const clock = (date: Date) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local(date).day]} ${String(Math.floor(local(date).minutes / 60)).padStart(2, '0')}:${String(local(date).minutes % 60).padStart(2, '0')}`;

test('the baseline keeps the feed moving between the windows that matter', () => {
  // Tuesday 08:00 Eastern.
  const next = nextRun(new Date('2026-10-27T12:00:00.000Z'));
  assert.equal(next?.window.id, 'baseline');
  assert.equal(clock(next!.at), 'Tue 12:00');
});

test('ingestion runs before the Wednesday waiver window, twice', () => {
  const evening = nextRun(new Date('2026-10-28T00:00:00.000Z'));
  assert.equal(evening?.window.id, 'waiver-preflight-evening');
  assert.equal(clock(evening!.at), 'Tue 21:00');

  const final = nextRun(new Date('2026-10-28T02:00:00.000Z'));
  assert.equal(final?.window.id, 'waiver-preflight-final');
  assert.equal(clock(final!.at), 'Wed 01:30');
  // Sleeper processes standard waivers early Wednesday Eastern; the last run must precede it.
  assert.ok(local(final!.at).minutes < 3 * 60, 'the final preflight lands before 03:00 Eastern');
});

test('each practice and game-status report gets its own run', () => {
  const wednesday = nextRun(new Date('2026-10-28T20:00:00.000Z'));
  assert.equal(wednesday?.window.id, 'injury-report-wednesday');
  assert.equal(clock(wednesday!.at), 'Wed 18:00');

  const friday = nextRun(new Date('2026-10-30T19:00:00.000Z'));
  assert.equal(friday?.window.id, 'injury-report-friday');
  assert.equal(clock(friday!.at), 'Fri 17:00');
});

test('game days are sampled often enough to catch an inactives list', () => {
  // Sunday morning Eastern, after the change off daylight time on 1 November 2026.
  let at = new Date('2026-11-01T13:07:00.000Z');
  const times: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const next = nextRun(at)!;
    assert.equal(next.window.id, 'gameday-sunday');
    times.push(clock(next.at));
    at = next.at;
  }
  assert.deepEqual(times, ['Sun 08:15', 'Sun 08:30', 'Sun 08:45', 'Sun 09:00']);
});

test('Thursday and Monday night windows are covered at a slower cadence', () => {
  const thursday = nextRun(new Date('2026-10-29T23:00:00.000Z'))!;
  assert.equal(thursday.window.id, 'gameday-thursday');
  assert.equal(clock(thursday.at), 'Thu 19:30');
  const monday = nextRun(new Date('2026-11-03T00:00:00.000Z'))!;
  assert.equal(monday.window.id, 'gameday-monday');
  assert.equal(clock(monday.at), 'Mon 19:30');
});

test('the schedule crosses a daylight-saving change without repeating or skipping a run', () => {
  // 1 November 2026: US clocks go back an hour at 02:00 local.
  let at = new Date('2026-11-01T04:00:00.000Z');
  const seen = new Set<number>();
  for (let index = 0; index < 40; index += 1) {
    const next = nextRun(at)!;
    assert.ok(next.at.getTime() > at.getTime(), 'time always moves forward');
    assert.ok(!seen.has(next.at.getTime()), 'no instant is scheduled twice');
    seen.add(next.at.getTime());
    at = next.at;
  }
  assert.equal(seen.size, 40);
});

test('every window is reachable, so none is dead configuration', () => {
  const reached = new Set<string>();
  let at = new Date('2026-10-25T00:00:00.000Z');
  for (let index = 0; index < 400; index += 1) { const next = nextRun(at)!; reached.add(next.window.id); at = next.at; }
  assert.deepEqual([...reached].sort(), DEFAULT_WINDOWS.map(window => window.id).sort());
});

test('the schedule runs, reschedules, and survives an ingestion that throws', async () => {
  const runs: Array<{ season: string; week: number }> = [];
  let fail = true;
  const service = {
    ingest: async (season: string, week: number) => {
      runs.push({ season, week });
      if (fail) { fail = false; throw new Error('upstream down'); }
      return { status: 'published', players: 1, identity: { rate: 1 }, breaches: [] } as unknown as IngestionReport;
    },
  } as unknown as ProjectionIngestionService;

  const timers: Array<() => void> = [];
  const errors: string[] = [];
  const schedule = new IngestionSchedule(service, () => ({ season: '2026', week: 8 }), {
    now: () => new Date('2026-10-27T12:00:00.000Z'),
    setTimer: handler => { timers.push(handler); return {}; },
    logger: { info: () => undefined, error: (_fields, message) => errors.push(message) },
  });

  schedule.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs, [{ season: '2026', week: 8 }], 'a restarted process ingests immediately rather than waiting for a window');
  assert.ok(errors.some(message => /ingestion threw/.test(message)));

  timers[0]!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs.length, 2, 'a failed run does not stop the schedule');
  schedule.stop();
});
