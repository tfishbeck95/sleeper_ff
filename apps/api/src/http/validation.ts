import type express from 'express';
import { validPlayerId } from '../players.js';
import { defaultTradeBounds } from '../trades.js';
import { HttpError } from './errors.js';

/**
 * One definition per thing a request can name, shared by every route that names it.
 *
 * Before this, a week was validated in four different ways across five routes:
 * `Number(req.query.week)` checked for an integer in one, defaulted to 1 in another, and reached the
 * command centre as `NaN` in a third. Most of those readings were right, and the shapes still
 * drifted — which is the argument for shared schemas over inline checks. Not that an inline check
 * cannot be correct, but that five of them cannot stay correct.
 *
 * What the schemas enforce beyond type:
 *
 * - **Unknown parameters are refused.** A query this application does not read is either a typo,
 *   which should be reported rather than ignored, or an attempt to reach a parameter some layer
 *   downstream does read. `?week=8&rosterId=2` must not quietly answer for the caller's own roster.
 * - **Repeated parameters are refused.** Express turns `?week=8&week=9` into an array, and every
 *   `typeof value === 'string'` check in the codebase silently disagreed about what to do with one.
 * - **Nothing is coerced into being valid.** `Number('')` is 0, `Number(' 8 ')` is 8 and
 *   `Number('8abc')` is NaN, so a parameter is parsed from an exact lexical shape instead.
 * - **The refusal never quotes the value.** It names the parameter and the shape expected. The value
 *   came from the caller, and a response that repeats it is a response that can be aimed at somebody
 *   else's browser.
 */

export class ValidationError extends HttpError {
  constructor(message: string, readonly parameter: string) { super(400, message, { code: 'invalid_request' }); this.name = 'ValidationError'; }
}

const invalid = (name: string, expectation: string) => new ValidationError(`'${name}' must be ${expectation}.`, name);

/** A parser for one parameter: the raw value as it arrived, and what it has to be. */
export interface Rule<T> {
  /** Human-readable expectation, used to build the refusal and to document the route. */
  readonly expectation: string;
  /** Whether the parameter may be absent. A required parameter that is absent is a 400. */
  readonly optional?: boolean;
  /** What absence means, when it means something other than `undefined`. */
  readonly fallback?: () => T;
  parse(raw: string, name: string): T;
}

const rule = <T>(expectation: string, parse: (raw: string, name: string) => T): Rule<T> => ({ expectation, parse });

/** An integer in an inclusive range, written exactly as digits — not `8.0`, ` 8`, `+8` or `8e0`. */
export const integer = (min: number, max: number) =>
  rule(`a whole number from ${min} to ${max}`, (raw, name) => {
    const expectation = `a whole number from ${min} to ${max}`;
    if (!/^-?\d{1,9}$/.test(raw)) throw invalid(name, expectation);
    const value = Number(raw);
    if (value < min || value > max) throw invalid(name, expectation);
    return value;
  });

/** A finite decimal in an inclusive range. Used by the trade bounds, which are ratios. */
export const decimal = (min: number, max: number) =>
  rule(`a number from ${min} to ${max}`, (raw, name) => {
    const expectation = `a number from ${min} to ${max}`;
    if (!/^-?\d{1,9}(\.\d{1,6})?$/.test(raw)) throw invalid(name, expectation);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw invalid(name, expectation);
    return value;
  });

/** One of a fixed set of words. */
export const enumeration = <const T extends readonly string[]>(values: T) =>
  rule<T[number]>(`one of ${values.join(', ')}`, (raw, name) => {
    if (!(values as readonly string[]).includes(raw)) throw invalid(name, `one of ${values.join(', ')}`);
    return raw as T[number];
  });

/** `true` or `false` and nothing else: `?force=1` is a typo, not a request to force. */
export const flag = () =>
  rule('true or false', (raw, name) => {
    if (raw !== 'true' && raw !== 'false') throw invalid(name, 'true or false');
    return raw === 'true';
  });

/** A string matching an exact pattern, bounded in length before the pattern ever runs. */
export const pattern = (regex: RegExp, maxLength: number, expectation: string) =>
  rule(expectation, (raw, name) => {
    if (raw.length > maxLength || !regex.test(raw)) throw invalid(name, expectation);
    return raw;
  });

/** A bounded comma-separated list, every entry parsed by the same rule. */
export const list = <T>(item: Rule<T>, maxEntries: number, expectation: string) =>
  rule<T[]>(expectation, (raw, name) => {
    const entries = raw.split(',');
    if (entries.length > maxEntries || entries.some(entry => !entry)) throw invalid(name, expectation);
    return entries.map(entry => item.parse(entry, name));
  });

/** Marks a rule as satisfiable by absence, which then reads as `undefined`. */
export const optional = <T>(item: Rule<T>): Rule<T | undefined> => ({ expectation: item.expectation, optional: true, parse: item.parse });

/** Absence means this value. Anything present is still parsed, so a default never hides a bad value. */
export const withDefault = <T>(item: Rule<T>, value: T): Rule<T> => ({ expectation: item.expectation, optional: true, fallback: () => value, parse: item.parse });

/**
 * The application's own vocabulary, defined once.
 *
 * A change to what a league id may look like belongs here, where every route that accepts one picks
 * it up, rather than in eleven separate `String(req.params.leagueId)` expressions.
 */
export const fields = {
  /**
   * A league identifier.
   *
   * It reaches an upstream URL and a storage key, so the alphabet is the point: no separators, no
   * dots, no percent-encoding, nothing that can traverse a path or open a second query. It is not
   * narrowed to digits, which is what Sleeper happens to issue today — the account's own list of
   * linked leagues is the authorization, and encoding somebody else's id format as a security
   * control means their next change to it reads as an attack here.
   *
   * The shape is checked before that list is consulted, so a malformed id is a 400 rather than a 403
   * that would imply the id exists and belongs to somebody else.
   */
  leagueId: pattern(/^[A-Za-z0-9_-]{1,32}$/, 32, 'a Sleeper league id of up to 32 letters, digits, underscores or hyphens'),
  /** The NFL regular season. Every engine in this application refuses a week outside it. */
  week: integer(1, 18),
  /** The transactions round, which tracks the week but is requested separately. */
  round: integer(1, 18),
  season: pattern(/^(19|20)\d{2}$/, 4, 'a four-digit season'),
  seasons: list(pattern(/^(19|20)\d{2}$/, 4, 'four-digit seasons'), 6, 'up to six comma-separated four-digit seasons'),
  /** Sleeper usernames: letters, digits and a few separators. Sent upstream, so bounded tightly. */
  sleeperUsername: pattern(/^[A-Za-z0-9._-]{1,64}$/, 64, 'a Sleeper username of 1 to 64 letters, digits, dots, underscores or hyphens'),
  sleeperUserId: pattern(/^[A-Za-z0-9_-]{1,32}$/, 32, 'a Sleeper user id of up to 32 letters, digits, underscores or hyphens'),
  playerIds: list(pattern(/^[A-Za-z0-9_-]{1,64}$/, 64, 'player ids'), 100, '1 to 100 comma-separated player ids'),
  /**
   * A name search. Two characters is the floor the directory search itself enforces, and control
   * characters are excluded because the only thing they can do to a search is corrupt a log line.
   */
  playerQuery: pattern(/^[^\u0000-\u001f\u007f]{2,100}$/, 100, 'a search of 2 to 100 characters'),
  resultLimit: integer(1, 50),
  force: flag(),
  leagueFormat: enumeration(['redraft', 'dynasty'] as const),
} as const;

/**
 * The trade bounds, as query parameters.
 *
 * The ranges mirror `parseTradeBounds`, which stays the authority — it is also reached from the
 * engines' own callers, which pass an object rather than a query string. Stating the ranges here as
 * well is what lets the query layer refuse `maxResults=999` before a bounds object exists at all, and
 * the route's round trip back through `parseTradeBounds` is what keeps the two from drifting.
 */
export const tradeBoundFields = {
  maxValueGap: optional(decimal(0, 1)),
  maxRisk: optional(decimal(0, 1)),
  minNeedGain: optional(decimal(0.01, 50)),
  maxRebuilderLineupLoss: optional(decimal(0, 1)),
  maxResults: optional(integer(1, 30)),
  maxAssetsPerTeam: optional(integer(1, 30)),
} satisfies Record<keyof typeof defaultTradeBounds, Rule<number | undefined>>;

/** The bounds actually supplied, ready for `parseTradeBounds` to apply its own authority to. */
export const suppliedBounds = (parsed: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(Object.keys(tradeBoundFields)
    .filter(name => typeof parsed[name] === 'number')
    .map(name => [name, parsed[name] as number]));

type Shape = Record<string, Rule<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends Rule<infer T> ? T : never };

/**
 * Applies a schema to one source of named values.
 *
 * A parameter that is absent from the query string may fall back to a default; one that is present
 * and empty may not. `?ids=` is a caller who built a list and got nothing into it, which is a bad
 * request, not an invitation to answer with every player on the roster instead.
 */
function apply<S extends Shape>(source: Record<string, unknown>, schema: S, kind: 'query parameter' | 'path parameter'): Parsed<S> {
  for (const name of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) throw new ValidationError(`'${name}' is not a recognized ${kind}.`, name);
  }
  const parsed: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(schema) as [string, Rule<unknown>][]) {
    const raw = source[name];
    // An array means the parameter was supplied more than once. Picking one of them is a guess at
    // which the caller meant, and the two readings can differ in what they authorize.
    if (Array.isArray(raw)) throw new ValidationError(`'${name}' was supplied more than once.`, name);
    if (raw !== undefined && typeof raw !== 'string') throw invalid(name, item.expectation);
    // Absent and present-but-empty are different requests. `?week=` supplies a week the caller left
    // blank, and every rule below refuses an empty value, so it is parsed rather than defaulted; only
    // a parameter that is not in the query string at all falls back.
    if (raw === undefined) {
      if (!item.optional) throw new ValidationError(`'${name}' is required: it must be ${item.expectation}.`, name);
      parsed[name] = item.fallback?.();
      continue;
    }
    parsed[name] = item.parse(raw, name);
  }
  return parsed as Parsed<S>;
}

/** Parses and validates the whole query string, refusing anything the route does not read. */
export const query = <S extends Shape>(req: express.Request, schema: S): Parsed<S> =>
  apply(req.query as Record<string, unknown>, schema, 'query parameter');

/** Parses one route parameter through a shared rule, so a route never handles a raw `req.params`. */
export function param<T>(req: express.Request, name: string, item: Rule<T>): T {
  const raw = req.params[name];
  if (typeof raw !== 'string' || raw === '') throw new ValidationError(`'${name}' is required: it must be ${item.expectation}.`, name);
  return item.parse(raw, name);
}

/** The player selection: ids, or a name search, never both — and never neither read as both. */
export type PlayerSelection = { ids: string[] } | { query: string; limit: number } | null;
export function playerSelection(req: express.Request): PlayerSelection {
  const parsed = query(req, {
    ids: optional(fields.playerIds),
    q: optional(fields.playerQuery),
    limit: withDefault(fields.resultLimit, 25),
  });
  if (parsed.ids && parsed.q) throw new ValidationError("Choose either 'ids' or a name search in 'q', not both.", 'ids');
  if (parsed.ids) {
    // The directory's own rule, applied to entries that already parsed: a syntactically plausible id
    // the directory would refuse is still a bad request rather than an empty result.
    if (!parsed.ids.every(validPlayerId)) throw invalid('ids', fields.playerIds.expectation);
    return { ids: parsed.ids };
  }
  if (parsed.q) {
    const trimmed = parsed.q.trim();
    if (trimmed.length < 2) throw invalid('q', fields.playerQuery.expectation);
    return { query: trimmed, limit: parsed.limit };
  }
  return null;
}
