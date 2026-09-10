# Identity, Sleeper linking, and sessions

## Product identity policy

Sleeper's documented public API does not authenticate ownership of an account. Huddle therefore treats a linked public Sleeper username as a **claimed association**, not verified identity. It must never be presented as proof that the application user owns that Sleeper account.

A private, single-user installation must protect the entire application with a long, unique private login password (or an upstream access gateway). A multi-user launch must replace the private login with an application identity provider supporting verified identities and account recovery. The claimed-association label remains mandatory unless Sleeper introduces a supported ownership-verification mechanism. Do not request, collect, or proxy Sleeper passwords or Sleeper session cookies.

## Security model

Application users and sessions are persisted separately from public Sleeper users. A user record stores the selected Sleeper user ID and an allow-list of selected league IDs. Protected league routes first authenticate the application session, then obtain the Sleeper ID and league authorization only from that record; client-supplied `userId` values are not identity inputs.

Passwords use Node's `scrypt` with a random salt. Session and CSRF secrets contain 256 bits of randomness. Only the session ID digest is stored; the CSRF token is retained with its digest so an already-authenticated browser can restore protection after a page reload. Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, host-only cookies. Sessions expire, can be rotated, are revoked at logout, and support administrative user-wide revocation in the store. Mutating API routes require a per-session CSRF header.

Demo login is opt-in with `ENABLE_DEMO_AUTH=true` on the API and `VITE_ENABLE_DEMO_AUTH=true` in a local frontend build, is unavailable in production, and production startup fails closed if it is enabled. Production also refuses to start without a valid password hash; an identity-provider integration must be implemented before a multi-user launch.

## Operations

Generate a hash with `npm run password-hash -w @sleeper/api -- 'a-long-unique-password'`, place it in `APP_LOGIN_PASSWORD_HASH`, and serve the application over HTTPS. Revoking a compromised account means calling the store's user-wide revocation operation (an administrative interface should wrap this before a multi-user launch). Session storage in the JSON file is suitable for a private deployment; multi-instance production requires a transactional shared database and distributed rate-limit store. `DEMO_SLEEPER_LEAGUE_IDS` may select additional development fixtures, but it has no effect unless demo authentication is enabled. Production deployments must put both the frontend and API behind the same HTTPS access boundary; serving the frontend publicly while protecting only `/api` does not satisfy the private-deployment policy.
