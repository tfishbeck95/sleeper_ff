-- 0001 application identity: accounts, sessions and Sleeper account associations.
--
-- This is the first migration that stores user-specific data, so it is also the first one that must
-- not be applied before the procedures in docs/data-durability.md are in place: everything below is
-- either a credential digest or a record of who someone is, and none of it can be re-fetched from
-- Sleeper after a bad restore.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE schema_migrations IS
  'One row per applied migration. Every up file inserts its version; every down file deletes it.';

-- Shared guard for append-only observation tables. An observation is what we saw at a point in time:
-- correcting it in place would silently rewrite the provenance every ranking cites. Retention still
-- deletes rows, which is why this forbids UPDATE only.
CREATE FUNCTION huddle_forbid_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'relation % is append-only; insert a new observation instead of updating %',
    TG_TABLE_NAME, OLD;
END;
$$;

CREATE TABLE app_user (
  id             uuid PRIMARY KEY,
  login          text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_login_unique UNIQUE (login),
  -- Sign-in lowercases the submitted login before it is compared, so storing anything else would
  -- create a row nobody can ever authenticate as.
  CONSTRAINT app_user_login_lowercase CHECK (login = lower(login))
);

/*
 * Sessions hold digests only: the raw session id and every CSRF token exist solely in the client's
 * cookie jar and memory. `expires_at` is the sliding idle deadline, `absolute_expires_at` the hard cap
 * rotation carries forward and never extends, and a rotated predecessor keeps its row so a later
 * replay is recognised as theft rather than treated as an unknown session.
 */
CREATE TABLE app_session (
  id_hash              text PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  family_id            uuid NOT NULL,
  created_at           timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  last_rotated_at      timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  superseded_at        timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text CHECK (revoked_reason IN ('logout', 'logout-all', 'rotated', 'expired', 'reuse-detected', 'user-removed')),
  CONSTRAINT app_session_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  -- The idle deadline is capped by the absolute one. A row that violates this would outlive the
  -- lifetime the operator configured.
  CONSTRAINT app_session_idle_within_absolute CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX app_session_user_idx ON app_session (user_id);
-- Logout and theft detection act on a whole rotation family at once.
CREATE INDEX app_session_family_idx ON app_session (family_id);
-- Retention sweeps by the last moment a row could still authenticate anything.
CREATE INDEX app_session_retention_idx ON app_session (absolute_expires_at);

CREATE TABLE app_session_csrf (
  session_id_hash  text NOT NULL REFERENCES app_session (id_hash) ON DELETE CASCADE,
  csrf_hash        text NOT NULL,
  issued_at        timestamptz NOT NULL,
  PRIMARY KEY (session_id_hash, csrf_hash)
);
-- A session keeps its most recent tokens so open tabs survive rotation; the oldest are trimmed.
CREATE INDEX app_session_csrf_recent_idx ON app_session_csrf (session_id_hash, issued_at DESC);

/*
 * The Sleeper account an application account claims.
 *
 * `sleeper_user_id` is deliberately not globally unique: two application accounts in one household can
 * legitimately claim the same Sleeper account, and refusing that would be a data-model opinion about
 * how people share a login. What must be unique is one claim per application account, which the
 * primary key gives, and the pair, which the second constraint gives.
 */
CREATE TABLE sleeper_account (
  user_id           uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  sleeper_user_id   text NOT NULL,
  sleeper_username  text NOT NULL,
  linked_at         timestamptz NOT NULL,
  CONSTRAINT sleeper_account_pair_unique UNIQUE (user_id, sleeper_user_id)
);
CREATE INDEX sleeper_account_sleeper_user_idx ON sleeper_account (sleeper_user_id);

/*
 * Which leagues an application account links.
 *
 * This is the input to connection reconciliation rather than a child of it, so it carries no foreign
 * key to `league_connection`: a league is linked first and becomes a connection on the next sweep.
 */
CREATE TABLE app_user_league (
  user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  sleeper_league_id  text NOT NULL,
  linked_at          timestamptz NOT NULL,
  PRIMARY KEY (user_id, sleeper_league_id)
);
-- Retention asks the opposite question — does any account still link this league — on every sweep.
CREATE INDEX app_user_league_league_idx ON app_user_league (sleeper_league_id);

INSERT INTO schema_migrations (version, name) VALUES ('0001', 'application_identity');

COMMIT;
