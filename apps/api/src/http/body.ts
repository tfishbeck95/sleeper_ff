import express from 'express';
import { HttpError } from './errors.js';

/**
 * How much of a request body this API will read, and of what.
 *
 * Every route here takes either nothing or a small object: a login, a Sleeper username and up to
 * fifty league ids. None of them has a reason to accept a megabyte, and a limit is only a limit if
 * it is the size of what the route actually needs — a global 32kb allowance applied to a two-field
 * login form is thirty kilobytes of parsing an unauthenticated caller can spend at will, times
 * however many connections they can open.
 *
 * Two decisions shape this file:
 *
 * **Bodies are parsed per route, not globally.** A parser mounted on the application reads a body
 * for every route, including the ones that take none, which means an endpoint that ignores its input
 * still pays to decode it. Mounting the parser on the routes that have a body instead makes the
 * limit specific — and makes a body sent to `POST /auth/logout` something that is never read at all.
 *
 * **The content type is checked before the body is.** `express.json` skips anything that is not
 * JSON and leaves `req.body` empty, so a form-encoded login arrives at the route as a login with no
 * password and fails as a wrong password. Refusing it as an unsupported media type says what
 * actually happened, and stops a route from ever seeing a half-read request.
 */

/**
 * The ceiling nothing may exceed, enforced before any route-specific parser runs.
 *
 * `Content-Length` is a claim rather than a fact, so this is a cheap pre-filter and not the limit
 * itself: the parser counts bytes as it reads them and stops at its own, smaller, allowance. What
 * this catches is the request that announces ten megabytes, which there is no reason to begin
 * reading.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/** What each endpoint is actually asking for, rather than one number for all of them. */
export const BODY_LIMITS = {
  /** A login and a password. Generous at 2kb; the fields it holds are bounded by the store. */
  credentials: '2kb',
  /** A Sleeper username and up to fifty league ids of about twenty characters each. */
  accountLink: '4kb',
} as const;

const JSON_TYPES = /^application\/(json|[\w.+-]+\+json)$/i;

/**
 * Refuses a body this API cannot read, before anything tries to read it.
 *
 * Applied to the whole application, so it also covers the routes that mount no parser: a request
 * that arrives with a body and a content type nobody here accepts is answered rather than silently
 * ignored.
 */
export function guardBody(): express.RequestHandler {
  return (req, _res, next) => {
    const length = Number(req.headers['content-length'] ?? 0);
    const type = req.headers['content-type'];
    const hasBody = req.headers['transfer-encoding'] !== undefined || length > 0;
    if (!hasBody) return next();
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return next(new HttpError(413, 'The request body is larger than this endpoint accepts.', { code: 'body_too_large' }));
    }
    // A media type is only meaningful when there is a body; the parameters after the first `;` are
    // the charset, which `express.json` validates itself.
    const media = typeof type === 'string' ? type.split(';')[0]!.trim().toLowerCase() : '';
    if (!JSON_TYPES.test(media)) {
      return next(new HttpError(415, 'The request body must be application/json.', { code: 'unsupported_media_type' }));
    }
    return next();
  };
}

/**
 * A JSON parser for one route, bounded to what that route needs.
 *
 * `strict` keeps the body an object or an array: a bare `"string"` or `null` is valid JSON and is
 * never what one of these routes meant, and accepting it means every reader downstream has to check.
 */
export function jsonBody(limit: string): express.RequestHandler {
  return express.json({ limit, strict: true, type: ['application/json', 'application/*+json'] });
}
