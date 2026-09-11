import { createHash } from 'node:crypto';

/**
 * One JSON object per line, with everything that must never reach a log removed on the way out.
 *
 * Structured rather than formatted because a log line is read twice: once by a person during an
 * incident, and a thousand times by whatever aggregates them. `console.info('sync failed', fields)`
 * serves neither — the message is not a field, the fields are not searchable, and an object logged at
 * depth prints as `[Object]`.
 *
 * Redaction happens here rather than at each call site, because the call site is exactly where it gets
 * forgotten. Four classes of value must never be written down, and each of them reaches a logger by
 * accident rather than on purpose:
 *
 * - **Session material.** A session id, a CSRF token or their digests in a log is a session anyone
 *   with log access can resume. They arrive through an error carrying a cookie, or through a field
 *   someone added while debugging.
 * - **Provider credentials.** The forecast subscription key is a request header, so it arrives inside
 *   a fetch error's message or a URL that was built with it.
 * - **Filesystem paths.** `ENOENT: no such file or directory, open '/var/lib/huddle/store.json'` is
 *   the layout of the deployment, published to whoever can read the logs, and it is what every storage
 *   failure says.
 * - **Personal settings.** The login, the linked Sleeper username, a display name: the account's own
 *   identifiers. Correlation needs a stable handle, not a name, so those become `identify()` digests.
 *
 * The rules are deliberately blunt. A blunt rule redacts a few things that did not need it; a precise
 * one misses the field nobody thought of.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  /** A logger that carries fields — the request id, the league — onto every line it writes. */
  child(fields: LogFields): Logger;
}

/** `silent` is a floor nothing clears: `LOG_LEVEL=silent` turns a process's own logging off. */
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Names whose value is never written down, whatever it holds. Matched after stripping punctuation. */
const SECRET_KEYS = new Set([
  'authorization', 'auth', 'cookie', 'cookies', 'setcookie', 'password', 'passwordhash', 'passwd',
  'token', 'csrf', 'csrftoken', 'csrfhash', 'csrfhashes', 'sessionid', 'rawsessionid', 'idhash',
  'secret', 'credential', 'credentials', 'apikey', 'subscriptionkey', 'signature', 'databaseurl',
  'sportsdataioapikey', 'applicationpasswordhash', 'appLoginPasswordHash'.toLowerCase(),
]);
/** Names that hold a person rather than a secret: replaced by a stable digest, not by a constant. */
const PERSONAL_KEYS = new Set([
  'login', 'username', 'sleeperusername', 'displayname', 'email', 'userid', 'sleeperuserid',
  'ownerid', 'familyid', 'user', 'owner',
]);
/** Names whose value is a person's configuration rather than the application's. */
const SETTINGS_KEYS = new Set(['settings', 'scoringsettings', 'rawsettings', 'preferences', 'metadata', 'body', 'headers', 'query']);
/** Names whose value is a path, and which are therefore reported as whether there is one. */
const PATH_KEYS = new Set(['path', 'filepath', 'file', 'datafile', 'dir', 'directory', 'cwd', 'waiversignalspath', 'projectionfeedpath']);
/**
 * Names whose value this application generates rather than receives.
 *
 * A route pattern is `/api/dashboard/:leagueId` — a literal from the route table, and the single
 * most useful field in an access log. It is also, to a blunt rule, indistinguishable from an
 * absolute filesystem path, so the path rule is skipped for these keys. Everything else still
 * applies: they are truncated, and a token-shaped run in one is still removed.
 */
const STRUCTURAL_KEYS = new Set(['route', 'component', 'method', 'bucket', 'scope', 'category', 'summary', 'reason', 'status', 'code']);

export const REDACTED = '[redacted]';
const MAX_DEPTH = 4, MAX_ARRAY = 20, MAX_STRING = 512, MAX_KEYS = 40;

const normalizeKey = (key: string) => key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/**
 * A stable, non-reversible handle for an identifier.
 *
 * Two lines about the same account can be joined without either of them naming it. It is truncated
 * because a full digest of a short, guessable value is a lookup table away from the value itself, and
 * eight hex characters are enough to correlate a single incident.
 */
export function identify(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `id:${createHash('sha256').update(String(value)).digest('hex').slice(0, 8)}`;
}

/**
 * A POSIX or Windows absolute path, anywhere in a string.
 *
 * Deliberately greedy about what counts as a path: it runs inside error messages, and the alternative
 * to redacting `/var/lib/huddle/store.json` out of an `ENOENT` is publishing the deployment's layout.
 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s'"`,;:)\]}]*[^\s'"`,;:)\]}.]/g;
/**
 * A token-shaped run: 32 or more characters from the base64url/hex alphabet with no separator.
 *
 * Session ids and CSRF tokens are 43 characters of base64url, their digests 64 of hex, so anything
 * that long and that dense is treated as material rather than as an identifier. UUIDs are exempt:
 * they identify a league or a session family, they are not secret, and losing them would leave a log
 * line that cannot be joined to anything.
 */
const TOKEN_SHAPED = /\b(?![0-9]+\b)[A-Za-z0-9_-]{32,}\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A URL with its userinfo and query removed: the path is diagnostic, the query carries the key. */
function redactUrl(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}${url.search || url.username || url.password ? `?${REDACTED}` : ''}`;
  } catch { return null; }
}

/** Redacts what a string may be carrying without destroying what makes it worth logging. */
export function redactString(value: string, { structural = false } = {}): string {
  const asUrl = structural ? null : redactUrl(value);
  if (asUrl) return asUrl;
  const trimmed = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  const withoutPaths = structural ? trimmed : trimmed.replace(ABSOLUTE_PATH, REDACTED);
  return withoutPaths.replace(TOKEN_SHAPED, match => (UUID.test(match) ? match : REDACTED));
}

/** An error as fields: its name and a redacted message, and its stack only where a person reads it. */
function redactError(error: Error, includeStack: boolean): LogFields {
  const fields: LogFields = { name: error.name, message: redactString(error.message) };
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') fields.code = code;
  if (includeStack && error.stack) fields.stack = redactString(error.stack.split('\n').slice(0, 8).join('\n'));
  if (error.cause instanceof Error) fields.cause = redactError(error.cause, false);
  return fields;
}

export interface RedactOptions { includeStack?: boolean }

/** Walks a value, applying the key rules on the way down and the string rules at the leaves. */
export function redact(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return redactError(value, options.includeStack ?? false);
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return REDACTED;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map(entry => redact(entry, options, depth + 1));
    return value.length > MAX_ARRAY ? [...kept, `…${value.length - MAX_ARRAY} more`] : kept;
  }
  if (typeof value !== 'object') return REDACTED;
  const source = value as Record<string, unknown>;
  const out: LogFields = {};
  for (const key of Object.keys(source).slice(0, MAX_KEYS)) {
    const normalized = normalizeKey(key);
    if (SECRET_KEYS.has(normalized)) { out[key] = REDACTED; continue; }
    if (PERSONAL_KEYS.has(normalized)) {
      const entry = source[key];
      out[key] = typeof entry === 'string' || typeof entry === 'number' ? identify(String(entry)) : REDACTED;
      continue;
    }
    if (SETTINGS_KEYS.has(normalized)) { out[key] = REDACTED; continue; }
    if (PATH_KEYS.has(normalized)) { out[key] = source[key] === undefined || source[key] === null ? null : REDACTED; continue; }
    if (STRUCTURAL_KEYS.has(normalized) && typeof source[key] === 'string') { out[key] = redactString(source[key] as string, { structural: true }); continue; }
    out[key] = redact(source[key], options, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where a line goes. Replaced in tests; `console` in every process. */
  write?: (level: LogLevel, line: string) => void;
  /** Stacks are a developer's tool and a disclosure risk, so they are off where they cannot be read. */
  includeStack?: boolean;
  service?: string;
  now?: () => Date;
}

const consoleWrite = (level: LogLevel, line: string) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  const value = raw?.trim().toLowerCase();
  return value && value in LEVELS ? value as LogLevel : fallback;
}

/**
 * Builds a logger.
 *
 * The level and the stack policy default from the environment so every process — API, worker, CLI —
 * agrees without being told, and so a production deployment does not have to remember to turn stacks
 * off. `LOG_LEVEL` names the floor.
 */
export function createLogger(options: LoggerOptions = {}, env: NodeJS.ProcessEnv = process.env): Logger {
  const production = env.NODE_ENV === 'production';
  const level = options.level ?? parseLevel(env.LOG_LEVEL, production ? 'info' : 'debug');
  const floor = LEVELS[level];
  const write = options.write ?? consoleWrite;
  const includeStack = options.includeStack ?? !production;
  const now = options.now ?? (() => new Date());
  const service = options.service ?? env.LOG_SERVICE;

  const emit = (bound: LogFields) => (level: Exclude<LogLevel, 'silent'>, fields: LogFields, message: string) => {
    if (LEVELS[level] < floor) return;
    const line = { ts: now().toISOString(), level, msg: redactString(message), ...(service ? { service } : {}), ...(redact({ ...bound, ...fields }, { includeStack }) as LogFields) };
    // A field that cannot be serialized must not take the line with it: a circular reference in
    // something someone logged is not a reason to lose the incident.
    try { write(level, JSON.stringify(line)); }
    catch { write(level, JSON.stringify({ ts: line.ts, level, msg: line.msg, fields: '[unserializable]' })); }
  };

  const build = (bound: LogFields): Logger => {
    const at = emit(bound);
    return {
      debug: (fields, message) => at('debug', fields, message),
      info: (fields, message) => at('info', fields, message),
      warn: (fields, message) => at('warn', fields, message),
      error: (fields, message) => at('error', fields, message),
      child: fields => build({ ...bound, ...fields }),
    };
  };
  return build({});
}

/** The process-wide logger. Modules that are handed one use that instead; this is the default. */
export const logger: Logger = createLogger();

/** Discards everything. For tests, and for the one CLI whose output is its own JSON document. */
export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};
