import type { ProjectionIngestionService } from './ingest.js';
import type { IngestionReport } from './service-level.js';

/**
 * When ingestion runs.
 *
 * The cadence is driven by when the underlying facts change, not by a convenient round number. Three
 * moments matter to a manager and each gets its own window: the hours before waivers process, when a
 * wrong ranking becomes an irreversible claim; the evenings the NFL publishes practice and game-status
 * reports, when availability changes in bulk; and game days, when a Sunday inactives list can flip a
 * starter ninety minutes before kickoff. Everything else is covered by a slow baseline.
 *
 * All times are interpreted in the schedule's timezone (US Eastern by default) rather than the host's,
 * because the NFL's week is defined in Eastern time and a server that moves regions must not shift the
 * waiver preflight run into the window it was meant to precede.
 */

export interface ScheduleWindow {
  id: string;
  reason: string;
  /** Days of the week in the schedule timezone; 0 is Sunday. */
  days: number[];
  /** Local minutes from midnight: inclusive start, exclusive end. */
  from: number;
  to: number;
  /** Minutes between runs inside the window. */
  everyMinutes: number;
}

const hhmm = (hours: number, minutes = 0) => hours * 60 + minutes;
/** A single run at one local time, expressed as a one-minute window. */
const at = (id: string, reason: string, days: number[], hours: number, minutes = 0): ScheduleWindow =>
  ({ id, reason, days, from: hhmm(hours, minutes), to: hhmm(hours, minutes) + 1, everyMinutes: 1 });

export const DEFAULT_TIME_ZONE = 'America/New_York';

/**
 * Sleeper processes standard waivers early Wednesday morning Eastern, so the last useful ingestion is
 * the one that lands before it. Two runs rather than one: Tuesday evening leaves time to notice a
 * failed ingestion and re-run it by hand, and the early Wednesday run catches anything that moved
 * overnight.
 */
export const DEFAULT_WINDOWS: readonly ScheduleWindow[] = Object.freeze([
  at('waiver-preflight-evening', 'Tuesday evening, ahead of Wednesday waiver processing', [2], 21),
  at('waiver-preflight-final', 'Final refresh before Wednesday waiver processing', [3], 1, 30),
  at('injury-report-wednesday', 'After the first practice report of the week', [3], 18),
  at('injury-report-thursday', 'After the second practice report of the week', [4], 18),
  at('injury-report-friday', 'After the final game-status report', [5], 17),
  at('injury-report-saturday', 'Saturday elevations and weekend status changes', [6], 13),
  { id: 'gameday-thursday', reason: 'Thursday night kickoff window', days: [4], from: hhmm(18), to: hhmm(24), everyMinutes: 30 },
  { id: 'gameday-sunday', reason: 'Sunday inactives and kickoff windows', days: [0], from: hhmm(8), to: hhmm(24), everyMinutes: 15 },
  { id: 'gameday-monday', reason: 'Monday night kickoff window', days: [1], from: hhmm(18), to: hhmm(24), everyMinutes: 30 },
  { id: 'baseline', reason: 'Baseline refresh', days: [0, 1, 2, 3, 4, 5, 6], from: hhmm(6), to: hhmm(22), everyMinutes: 360 },
]);

interface LocalTime { day: number; minutes: number }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Reads a wall-clock day and minute in the schedule's timezone, so DST shifts are handled by the ICU data. */
export function localTime(date: Date, timeZone: string, formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })): LocalTime {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  // `hour: '2-digit'` with hour12 false renders midnight as 24 in some ICU versions; normalize it.
  const hour = Number(parts.hour) % 24;
  return { day: Math.max(0, DAYS.indexOf(parts.weekday ?? 'Sun')), minutes: hour * 60 + Number(parts.minute) };
}

const matches = (window: ScheduleWindow, time: LocalTime) =>
  window.days.includes(time.day) && time.minutes >= window.from && time.minutes < window.to && (time.minutes - window.from) % window.everyMinutes === 0;

/**
 * The next instant at or after `after` that any window calls for.
 *
 * Scanned minute by minute rather than computed in closed form: the arithmetic for "the next
 * Wednesday at 01:30 local" has to survive a spring-forward that deletes the hour it lands in, and a
 * scan over wall-clock readings is correct by construction where the arithmetic is fiddly to prove.
 */
export function nextRun(after: Date, windows: readonly ScheduleWindow[] = DEFAULT_WINDOWS, timeZone = DEFAULT_TIME_ZONE): { at: Date; window: ScheduleWindow } | null {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  // Start at the next whole minute so a run is never scheduled for the instant that just fired.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let step = 0; step <= 8 * 24 * 60; step += 1) {
    const candidate = new Date(start.getTime() + step * 60_000);
    const time = localTime(candidate, timeZone, formatter);
    const window = windows.find(value => matches(value, time));
    if (window) return { at: candidate, window };
  }
  return null;
}

export interface ScheduleOptions {
  windows?: readonly ScheduleWindow[];
  timeZone?: string;
  now?: () => Date;
  /** Runs once at startup, so a process restarted after an outage does not wait for the next window. */
  runOnStart?: boolean;
  logger?: { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void };
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

const defaultLogger = { info: (fields: Record<string, unknown>, message: string) => console.info(message, fields), error: (fields: Record<string, unknown>, message: string) => console.error(message, fields) };

/**
 * Drives the ingestion service on the schedule.
 *
 * Each run schedules the next one rather than firing on a fixed interval: an interval drifts against
 * wall-clock windows, and after a long ingestion it can queue several runs back to back. A failed
 * ingestion never stops the schedule — the service has already alerted and retained the last good
 * feed, and the next window is the retry.
 */
export class IngestionSchedule {
  private timer: unknown = null;
  private stopped = false;
  /** The ingestion in progress, so shutdown can wait for it. Never rejects: `ingest` handles its own failures. */
  private running: Promise<IngestionReport | null> | null = null;
  private readonly options: Required<Omit<ScheduleOptions, 'setTimer' | 'clearTimer' | 'logger'>> & Pick<ScheduleOptions, 'setTimer' | 'clearTimer'> & { logger: NonNullable<ScheduleOptions['logger']> };

  constructor(
    private readonly service: ProjectionIngestionService,
    private readonly target: () => { season: string; week: number },
    options: ScheduleOptions = {},
  ) {
    this.options = {
      windows: options.windows ?? DEFAULT_WINDOWS,
      timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
      now: options.now ?? (() => new Date()),
      runOnStart: options.runOnStart ?? true,
      logger: options.logger ?? defaultLogger,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    };
  }

  start(): void {
    this.stopped = false;
    if (this.options.runOnStart) void this.run('startup');
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as Parameters<typeof clearTimeout>[0]);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    const next = nextRun(this.options.now(), this.options.windows, this.options.timeZone);
    if (!next) { this.options.logger.error({}, '[projection-feed] no ingestion window matched; schedule stopped'); return; }
    const delay = Math.max(0, next.at.getTime() - this.options.now().getTime());
    this.options.logger.info({ at: next.at.toISOString(), window: next.window.id, reason: next.window.reason }, '[projection-feed] next ingestion scheduled');
    const timer = (this.options.setTimer ?? setTimeout)(() => { void this.run(next.window.id).finally(() => this.schedule()); }, delay);
    timer.unref?.();
    this.timer = timer;
  }

  /**
   * Resolves once an ingestion already under way has finished.
   *
   * `stop` cancels the next run; it says nothing about the one in progress. A window that fires
   * seconds before a deployment is otherwise abandoned part-way through resolving identities, which
   * costs the upstream call and produces nothing.
   */
  async settled(): Promise<void> { await this.running; }

  private run(trigger: string): Promise<IngestionReport | null> {
    const attempt = this.ingest(trigger).finally(() => { if (this.running === attempt) this.running = null; });
    this.running = attempt;
    return attempt;
  }

  private async ingest(trigger: string): Promise<IngestionReport | null> {
    const { season, week } = this.target();
    try {
      const report = await this.service.ingest(season, week);
      this.options.logger.info({ trigger, season, week, status: report.status, players: report.players, identityRate: report.identity.rate, breaches: report.breaches.length }, '[projection-feed] ingestion completed');
      return report;
    } catch (error) {
      // The service alerts and retains the last good feed on its own; the schedule must survive.
      this.options.logger.error({ trigger, season, week, message: error instanceof Error ? error.message : String(error) }, '[projection-feed] ingestion threw');
      return null;
    }
  }
}
