/**
 * The shared upstream client for licensed data sources.
 *
 * Mirrors the retry semantics of `@sleeper/sleeper-client` rather than inventing a second policy:
 * bounded timeout, bounded attempts, exponential backoff, and retries only for conditions that can
 * plausibly succeed on a second try. A 401 is a credential problem and retrying it just burns quota
 * against a key that is already wrong.
 */

export type FetchErrorCategory = 'timeout' | 'network' | 'rate_limit' | 'unauthorized' | 'not_found' | 'server' | 'client' | 'validation';

export class ProviderFetchError extends Error {
  constructor(
    public readonly source: string,
    public readonly status: number,
    message: string,
    public readonly category: FetchErrorCategory,
    public readonly retryable = false,
  ) { super(message); this.name = 'ProviderFetchError'; }
}

export interface ProviderHttpOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  /** Upper bound on one backoff wait, so a long retry chain cannot outlive the ingestion window. */
  maxBackoffMs?: number;
  /**
   * The ceiling on one call in total, across every attempt and every wait between them.
   *
   * Bounding each attempt does not bound their sum: four attempts at fifteen seconds, plus backoff,
   * is well over a minute on a client whose stated timeout is fifteen seconds. The budgets that fill
   * this in live in `config/upstream.ts`, alongside the Sleeper client's, so the two agree.
   */
  maxElapsedMs?: number;
}

/**
 * `Retry-After` is the source telling us exactly how long to wait; honouring it is the difference
 * between backing off and being rate-limited harder. Both the delta-seconds and HTTP-date forms are
 * accepted, and an absurd value is ignored rather than allowed to stall the run.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 && ms <= 120_000 ? ms : null;
}

export class ProviderHttpClient {
  private readonly options: Required<ProviderHttpOptions>;
  constructor(
    private readonly sourceName: string,
    private readonly fetcher: typeof fetch = fetch,
    options: ProviderHttpOptions = {},
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {
    this.options = { timeoutMs: options.timeoutMs ?? 15_000, maxRetries: options.maxRetries ?? 3, backoffMs: options.backoffMs ?? 500, maxBackoffMs: options.maxBackoffMs ?? 20_000, maxElapsedMs: options.maxElapsedMs ?? 90_000 };
  }

  /**
   * `headers` may carry a credential, so it is never logged and never attached to a thrown error.
   * Callers pass credentials as headers rather than query parameters for the same reason: a query
   * string reaches proxy logs and error reports intact.
   */
  async getJson<T>(url: string, validate: (value: unknown) => boolean, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    return this.request(url, async response => {
      const value: unknown = await response.json();
      // A source that answers 200 with an error envelope or an empty body is a validation failure,
      // not a feed: an unvalidated shape would reach identity resolution as zero resolvable players.
      if (!validate(value)) throw new ProviderFetchError(this.sourceName, 502, `${this.sourceName} returned an unexpected response shape`, 'validation');
      return value as T;
    }, headers, signal);
  }

  /** Bulk reference data is published as CSV far more often than as JSON; same retry policy. */
  async getText(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
    return this.request(url, async response => {
      const value = await response.text();
      if (!value.trim()) throw new ProviderFetchError(this.sourceName, 502, `${this.sourceName} returned an empty body`, 'validation');
      return value;
    }, headers, signal);
  }

  private async request<T>(url: string, read: (response: Response) => Promise<T>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      let wait: number | null = null;
      try {
        // Whatever is left of the whole-call budget, so no chain of attempts can outlive it.
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.options.timeoutMs, this.options.maxElapsedMs - (Date.now() - startedAt))));
        const response = await this.fetcher(url, { headers: { Accept: 'application/json', ...headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) {
          const category: FetchErrorCategory = response.status === 429 ? 'rate_limit'
            : response.status === 401 || response.status === 403 ? 'unauthorized'
            : response.status === 404 ? 'not_found' : response.status >= 500 ? 'server' : 'client';
          wait = retryAfterMs(response.headers.get('retry-after'));
          throw new ProviderFetchError(this.sourceName, response.status, `${this.sourceName} returned ${response.status}`, category, category === 'rate_limit' || category === 'server');
        }
        return await read(response);
      } catch (error) {
        const normalized = error instanceof ProviderFetchError ? error : new ProviderFetchError(
          this.sourceName, 503,
          error instanceof Error ? error.message : `${this.sourceName} is unavailable`,
          error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network', true,
        );
        if (signal?.aborted || !normalized.retryable || attempt >= this.options.maxRetries) throw normalized;
        const backoff = Math.min(this.options.backoffMs * 2 ** attempt, this.options.maxBackoffMs);
        // Full jitter: several ingestion jobs retrying a recovering source must not resynchronize onto it.
        const delay = wait ?? Math.random() * backoff;
        // Sleeping past the deadline only to start an attempt that is aborted on arrival spends the
        // rest of the ingestion window learning nothing.
        if (Date.now() - startedAt + delay >= this.options.maxElapsedMs) throw normalized;
        await this.sleep(delay);
      }
    }
  }
}

/**
 * Reads a credential from the environment, failing loudly when a source that needs one has none.
 * A missing key must stop the run: continuing yields an empty fetch, which is indistinguishable at
 * the storage layer from a week in which no player was projected.
 */
export function requireCredential(envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[envVar]?.trim();
  if (!value) throw new Error(`${envVar} is not set. The provider adapter requires a licensed credential; see docs/projection-provider.md.`);
  return value;
}
