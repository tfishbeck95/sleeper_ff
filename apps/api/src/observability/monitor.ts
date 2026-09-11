import { logger, type Logger } from '../log.js';
import type { WaiverSignalProvider } from '../waiver-signals.js';
import type { HuddleRepository } from '../storage/repositories.js';
import {
  CompositeAlertSink, DeduplicatingSink, LoggingAlertSink, TrafficWindow, WebhookAlertSink,
  evaluate, type AlertSink, type AlertThresholds, type OperationalAlert,
} from './alerts.js';
import { DEFAULT_ALERT_THRESHOLDS } from './alerts.js';
import { dependencyStatus } from './health.js';

/**
 * The thing that actually looks.
 *
 * Metrics are a record; an alert is somebody being told. Between them there has to be something that
 * reads the record on a clock and decides, and this is it — for the installation that has no
 * Prometheus attached, which is most of them. An installation that does have one should scrape
 * `/metrics` and use `deploy/alerts/huddle.rules.yml` instead; the rules there are the same
 * conditions expressed for a system that can do windows and `for` durations properly.
 *
 * It runs on the worker, not on the API instances. The conditions are about the installation — is
 * the schedule running, is the forecast fresh, are leagues falling behind — and evaluating them once
 * per API instance would mean one alert per instance for one condition. The worker already owns
 * exactly this class of whole-installation job.
 */

export interface OperationsMonitorOptions {
  store: Pick<HuddleRepository, 'activeLeagueConnections' | 'lease' | 'allLeagues'>;
  forecast: WaiverSignalProvider | null;
  sink?: AlertSink;
  thresholds?: AlertThresholds;
  /** How often to look. Long enough that a rate means something, short enough to matter. */
  intervalMs?: number;
  log?: Logger;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

export class OperationsMonitor {
  private readonly traffic = new TrafficWindow();
  private readonly sink: AlertSink;
  private readonly intervalMs: number;
  private readonly thresholds: AlertThresholds;
  private readonly log: Logger;
  private timer: unknown = null;
  private running: Promise<OperationalAlert[]> | null = null;
  private stopped = true;

  constructor(private readonly options: OperationsMonitorOptions) {
    this.sink = options.sink ?? new LoggingAlertSink(options.log ?? logger);
    this.intervalMs = Math.max(60_000, options.intervalMs ?? 5 * 60_000);
    this.thresholds = options.thresholds ?? DEFAULT_ALERT_THRESHOLDS;
    this.log = options.log ?? logger;
  }

  /**
   * One evaluation.
   *
   * Coalesced, because an evaluation reads storage and a check that is still running when the next
   * one fires would double the reads for no extra information.
   */
  check(): Promise<OperationalAlert[]> {
    if (!this.running) this.running = this.evaluateOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async evaluateOnce(): Promise<OperationalAlert[]> {
    try {
      const status = await dependencyStatus({ store: this.options.store, forecast: this.options.forecast, thresholds: this.thresholds, now: this.options.now });
      const alerts = evaluate(status, this.traffic.read(), this.thresholds, new Date(this.options.now?.() ?? Date.now()).toISOString());
      for (const alert of alerts) await this.sink.deliver(alert);
      // The healthy case is a debug line rather than silence: an operator asking "is the monitor
      // even running" should be able to answer it from the logs rather than by breaking something.
      if (!alerts.length) this.log.debug({ component: 'alerts', state: status.state }, 'no alerts');
      return alerts;
    } catch (error) {
      // A monitor that throws is a monitor that has stopped watching, which is worse than any
      // condition it was watching for.
      this.log.error({ component: 'alerts', error }, 'alert evaluation failed');
      return [];
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.check();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as Parameters<typeof clearTimeout>[0]);
    this.timer = null;
  }

  /** Waits for an evaluation already in flight, so a shutdown does not cut one in half. */
  async settled(): Promise<void> { await this.running?.catch(() => undefined); }

  private schedule(): void {
    if (this.stopped) return;
    const timer = (this.options.setTimer ?? setTimeout)(() => { void this.check().finally(() => this.schedule()); }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }
}

/**
 * Where alerts go.
 *
 * Console always, because a log line costs nothing and an installation with no webhook still has to
 * be able to find out what happened. A webhook in addition when one is configured, wrapped in the
 * repeat suppression so a condition that lasts an hour is one message rather than twelve.
 */
export function alertSinkFromEnv(env: NodeJS.ProcessEnv = process.env, log: Logger = logger): AlertSink {
  const console = new LoggingAlertSink(log);
  const webhook = env.OPS_ALERT_WEBHOOK?.trim();
  const sinks: AlertSink[] = webhook ? [console, new WebhookAlertSink(webhook, fetch, console)] : [console];
  const repeatAfterMs = Math.max(60_000, Number(env.OPS_ALERT_REPEAT_MINUTES ?? 60) * 60_000);
  return new DeduplicatingSink(new CompositeAlertSink(sinks), Number.isFinite(repeatAfterMs) ? repeatAfterMs : 60 * 60_000);
}
