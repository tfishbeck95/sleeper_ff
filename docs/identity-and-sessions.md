# Identity, Sleeper linking, and sessions

## Product identity policy

Sleeper's documented public API does not authenticate ownership of an account. Huddle therefore treats a linked public Sleeper username as a **claimed association**, not verified identity. It must never be presented as proof that the application user owns that Sleeper account, and the API labels it as `claimed` when the link is saved.

**Single-user installation.** The supported configuration today. One application login, protected by a long unique password (or an upstream access gateway), guards the entire application. The claimed association is safe here because the only person who can create it is the person who owns the installation. There is no account recovery: losing the password means generating a new hash and restarting.

**Multi-user launch.** Not supported by this configuration, and the private login must not simply be handed to several people. Before opening the application to more than one person it needs an application identity provider with verified identities, account recovery and an administrative interface, plus a shared transactional session store (below). Until Sleeper offers an ownership-verification mechanism, the claimed-association label stays mandatory even then — one user could otherwise link another person's Sleeper username and their leagues would appear to be endorsed by the application.

Never request, collect, or proxy Sleeper passwords or Sleeper session cookies, in any configuration.

## Security model

Application users and sessions are persisted separately from the public Sleeper users pulled in by synchronization. A user record stores the claimed Sleeper user ID and an allow-list of selected league IDs, and the selection is verified against the leagues Sleeper reports for that account before it is saved.

**Authorization.** Protected routes authenticate the session first, then read the Sleeper ID and the league allow-list only from the session's user record. A `userId` or league id in the request is a lookup key that must already be authorized, never an identity input: `/api/sleeper/users/:userId/leagues` refuses any id but the linked one, every `:leagueId` route refuses a league that is not in the allow-list, and roster-scoped analysis matches the roster by the session's Sleeper ID as owner or co-owner.

**Passwords.** Node's `scrypt` with a random 16-byte salt, stored as `scrypt:<salt>:<hash>`. An unknown login is verified against a throwaway hash so a failed sign-in costs the same as a successful one and response time does not disclose which logins exist.

**Sessions.** Session ids and CSRF tokens are 256 bits of `randomBytes`; the store keeps only SHA-256 digests, so a leaked copy of `store.json` cannot be replayed as a session. The cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and host-only (`__Host-` prefixed).

A session has three independent limits:

| Limit | Setting | Behaviour |
| --- | --- | --- |
| Absolute lifetime | `SESSION_TTL_HOURS` | Fixed at sign-in. Rotation carries it forward and never extends it. |
| Idle window | `SESSION_IDLE_MINUTES` | Moves forward as the session is used, capped by the absolute lifetime. Clamped to the absolute lifetime if configured longer. |
| Rotation interval | `SESSION_ROTATE_MINUTES` | A live session is issued a new id in place, transparently to the client. |

Rotation keeps the session's CSRF tokens, so no client work is needed. The retired id stays usable for `SESSION_ROTATION_GRACE_SECONDS` so requests already in flight do not fail. **After that window a retired id can only be a copy**, so presenting one — like presenting an already revoked id — revokes every session in that rotation family. Logout revokes the family; signing out everywhere (`POST /auth/logout-all`) revokes every session belonging to the user, and the same store operation is what an administrator uses to cut off a compromised account. Sessions that can no longer authenticate anything are pruned at sign-in and on the synchronization cadence, so the store does not grow without bound.

**CSRF.** Every mutating API request must carry `X-CSRF-Token` matching a token issued to that session; the token lives only in the client's memory, never in storage. `GET /auth/session` restores a reloaded page from its cookie and mints a fresh token, and a session holds the last few tokens it issued so a second tab does not invalidate the first.

**Rate limits.** Every budget is charged along two dimensions at once, because each alone has a hole the other closes.

| Dimension | Keyed on | What it bounds | Why it is not enough alone |
| --- | --- | --- | --- |
| Address | `req.ip`, IPv6 collapsed to its /64 | An anonymous flood, and everything before a request is authenticated | A household, an office or a carrier NAT is one address, so it has to be loose — loose enough for one signed-in client to spend it all |
| Session | The session *family* id, so a rotation does not reset it | One signed-in client, however many addresses it speaks from | It does not exist until a request is authenticated |

A request is refused when either is exhausted, and **both are charged either way** — so a caller cannot keep one budget intact by deliberately overspending a cheaper one. Sign-in adds a third budget keyed on the submitted login, so a botnet cannot grind one account by spreading attempts across addresses. The endpoints are budgeted by what they cost us rather than by what a client wants: the seven-call league detail route is an order of magnitude below a dashboard read that touches only the store. Counters live in the API process and are swept and capped, so rotating source addresses cannot grow them without bound.

`req.ip` is only the real client once `TRUST_PROXY` matches the deployment — see [deployment](deployment.md#configuration-that-must-be-right), where production refuses to guess.

## Development and demo isolation

Demo login and every sample-league response require `ENABLE_DEMO_AUTH=true` **and** a non-production `NODE_ENV`; production never serves either, whatever the flag says. `INSECURE_DEV_COOKIES=true` drops the `__Host-` prefix and `Secure` attribute for sign-in over plain http on a developer machine.

Startup fails closed rather than starting in a weakened state. `validateAuthenticationConfig` refuses to start when production has demo authentication or insecure cookies enabled, has neither a password hash nor an identity provider, has a password hash that is not a scrypt hash, or has no `WEB_ORIGIN`; when `WEB_ORIGIN` is not an absolute https origin (http is accepted only for localhost outside production); or when any session setting is not a positive number.

## Operations

Generate a hash with `npm run password-hash -w @sleeper/api -- 'a-long-unique-password'`, place it in `APP_LOGIN_PASSWORD_HASH`, and serve the application over HTTPS. Revoking a compromised account means calling the store's user-wide revocation operation; an administrative interface should wrap it before a multi-user launch.

Session storage in the JSON file and in-process rate-limit counters suit a single-instance private deployment. Running more than one instance requires a transactional shared session store and a shared rate-limit store first — otherwise rotation can race between instances and each instance enforces its own separate budget. The session tables are defined in [`apps/api/migrations`](../apps/api/migrations) (`app_session` and `app_session_csrf`, digests only, cascading from the account), and the JSON adapter is refused rather than merely discouraged for a multi-instance production deployment; see [storage](storage.md#choosing-an-adapter). The rate-limit store is still in-process and unchanged.
