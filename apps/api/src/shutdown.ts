import { beginDraining } from './lifecycle.js';
import { logger } from './log.js';

/**
 * Stopping on purpose.
 *
 * A container is stopped by `SIGTERM` and killed a short time later whether or not it has finished.
 * What happens in between is the difference between a rolling deploy nobody notices and one that
 * returns a handful of 502s, loses a half-written store, and leaves a league lease held by a process
 * that no longer exists until it expires.
 *
 * The order is the whole design, so steps run in the order they are added and each one is awaited:
 *
 * 1. **Stop taking new work.** The HTTP listener stops accepting connections, the worker stops
 *    scheduling sweeps, the ingestion schedule stops, and the housekeeping intervals are cleared.
 *    `/health` starts answering 503 before any of it, so the load balancer has a moment to notice.
 * 2. **Finish the work already in flight.** Requests already being served run to completion, and the
 *    synchronization jobs already started are drained rather than abandoned halfway through
 *    replacing a league's authoritative rows.
 * 3. **Release what is shared.** Leases are released rather than left to expire, and the repository
 *    handle is closed — the JSON adapter waits for its queued writes to land, and a pooled adapter
 *    ends its pool so PostgreSQL is not left holding connections for a process that has gone.
 *
 * Every step is bounded by one overall grace period. Past it the process exits anyway: an orchestrator
 * that asked a container to stop is going to kill it regardless, and a shutdown that hangs forever
 * turns a graceful stop into the ungraceful one it was meant to replace.
 */

export interface ShutdownLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

const consoleLogger: ShutdownLogger = {
  info: message => logger.info({ component: 'shutdown' }, message),
  error: (message, error) => (error === undefined ? logger.error({ component: 'shutdown' }, message) : logger.error({ component: 'shutdown', error }, message)),
};

/** The part of `process` this needs, so a test can drive it without signalling itself. */
export interface SignalSource {
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

export interface ShutdownOptions {
  /** How long the whole sequence may take before the process exits anyway. */
  graceMs: number;
  logger?: ShutdownLogger;
  exit?: (code: number) => void;
  signals?: readonly string[];
}

interface Step { name: string; run: () => void | Promise<void>; }

export class GracefulShutdown {
  private readonly steps: Step[] = [];
  private readonly logger: ShutdownLogger;
  private readonly exit: (code: number) => void;
  private readonly signals: readonly string[];
  private running: Promise<number> | null = null;

  constructor(private readonly options: ShutdownOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.exit = options.exit ?? (code => process.exit(code));
    this.signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  }

  /** Registers a step. They run in the order they were added, so add them in the order they must happen. */
  add(name: string, run: () => void | Promise<void>): this {
    this.steps.push({ name, run });
    return this;
  }

  get started() { return this.running !== null; }

  /**
   * Runs every step once, and resolves with the exit code.
   *
   * A step that fails does not stop the ones after it. Releasing a lease and closing the store matter
   * more when draining has just gone wrong, not less — the exit code records that something did.
   */
  shutdown(reason: string): Promise<number> {
    if (this.running) return this.running;
    beginDraining();
    this.logger.info(`[shutdown] ${reason}: draining, ${this.options.graceMs / 1000}s grace`);
    this.running = this.run();
    return this.running;
  }

  private async run(): Promise<number> {
    let code = 0;
    let outstanding = 'nothing';
    const sequence = (async () => {
      for (const step of this.steps) {
        outstanding = step.name;
        try { await step.run(); }
        catch (error) { code = 1; this.logger.error(`[shutdown] ${step.name} failed`, error); }
      }
      outstanding = 'nothing';
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), this.options.graceMs); });
    const outcome = await Promise.race([sequence.then(() => 'finished' as const), expired]);
    if (timer) clearTimeout(timer);
    if (outcome === 'expired') {
      // Naming the step is the whole value of the message: "shutdown timed out" sends someone reading
      // logs; "still waiting on drain in-flight synchronizations" sends them to the queue.
      this.logger.error(`[shutdown] grace period expired while waiting on ${outstanding}; exiting anyway`);
      return 1;
    }
    this.logger.info(code === 0 ? '[shutdown] complete' : '[shutdown] complete, with failures');
    return code;
  }

  /**
   * Installs the signal handlers, and returns a function that removes them.
   *
   * A second signal exits immediately. An operator who sends one, waits, and sends another has decided
   * the drain is not going to finish, and the process should not argue.
   */
  listen(source: SignalSource = process): () => void {
    const installed: { signal: string; handler: () => void }[] = [];
    for (const signal of this.signals) {
      const handler = () => {
        if (this.started) {
          this.logger.error(`[shutdown] second ${signal}: exiting immediately, in-flight work is abandoned`);
          this.exit(1);
          return;
        }
        void this.shutdown(signal).then(code => this.exit(code));
      };
      source.on(signal, handler);
      installed.push({ signal, handler });
    }
    return () => { for (const { signal, handler } of installed) source.off(signal, handler); };
  }
}

/**
 * Closes an HTTP server, and stops waiting on sockets that will never go idle.
 *
 * `server.close()` stops accepting new connections and resolves once the open ones end, which a
 * keep-alive client has no reason to do. Idle connections are closed straight away; the ones still
 * serving a request are given the rest of the grace period and then closed too, so a slow request
 * cannot hold the whole shutdown open.
 */
export function closeHttpServer(server: HttpServerLike, graceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    server.close(error => {
      if (timer) clearTimeout(timer);
      // `ERR_SERVER_NOT_RUNNING` means it was never listening or is already closed, which is the state
      // this wanted anyway.
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
    timer = setTimeout(() => server.closeAllConnections?.(), graceMs);
    timer.unref?.();
  });
}

export interface HttpServerLike {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}
