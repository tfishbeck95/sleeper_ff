-- 0008 what synchronization did, how fresh each resource is, and the leases that keep one worker in
-- charge of the schedule.
BEGIN;

/*
 * One synchronization attempt.
 *
 * The connection record keeps the *last* attempt because that is what the dashboard reports; this is
 * the log behind it, which is what an operator reads when a league has been failing for a day. It
 * hangs off the connection rather than off `league`, because a league that never synchronized
 * successfully has attempts worth keeping and no metadata row at all.
 */
CREATE TABLE sync_run (
  id               uuid PRIMARY KEY,
  league_id        text REFERENCES league_connection (league_id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('league', 'players', 'forecast')),
  status           text NOT NULL CHECK (status IN ('success', 'failed')),
  -- rate_limit, timeout, network, server, client, validation, internal.
  category         text,
  season           text CHECK (season ~ '^[0-9]{4}$'),
  week             smallint CHECK (week BETWEEN 1 AND 18),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  duration_ms      integer NOT NULL CHECK (duration_ms >= 0),
  refreshed        text[] NOT NULL DEFAULT '{}',
  next_attempt_at  timestamptz,
  worker_id        text,
  CONSTRAINT sync_run_failure_category CHECK (status = 'success' OR category IS NOT NULL),
  -- The player directory and the forecast feed are global; a league run names its league.
  CONSTRAINT sync_run_league_scope CHECK ((kind = 'league') = (league_id IS NOT NULL)),
  CONSTRAINT sync_run_ordering CHECK (finished_at >= started_at)
);
CREATE INDEX sync_run_league_idx ON sync_run (league_id, started_at DESC);
CREATE INDEX sync_run_recent_idx ON sync_run (started_at DESC);
-- The question an operator actually asks: what has been failing, and why.
CREATE INDEX sync_run_failure_idx ON sync_run (league_id, started_at DESC) WHERE status = 'failed';

/*
 * Per-resource freshness.
 *
 * Staleness is per resource, not per league: rosters are five minutes old, the member list can be six
 * hours old, and the shared player directory is a day old, all at once and all correctly. The key is
 * the same one the cache uses (`matchups:<league>:<season>:<week>`, `players:nfl`), with its parts
 * stored alongside so retention and reporting do not have to parse it.
 */
CREATE TABLE resource_freshness (
  resource_key     text PRIMARY KEY,
  -- Null for a resource that belongs to every league, such as the player directory.
  league_id        text REFERENCES league (id) ON DELETE CASCADE,
  resource         text NOT NULL,
  season           text CHECK (season ~ '^[0-9]{4}$'),
  week             smallint CHECK (week BETWEEN 1 AND 18),
  synchronized_at  timestamptz NOT NULL
);
CREATE INDEX resource_freshness_league_idx ON resource_freshness (league_id, resource);

/*
 * A lease held by one worker over one key.
 *
 * This is the table that makes a multi-instance deployment safe, and the reason the JSON adapter is
 * refused there: a sweep lease (`league-sync:sweep`) means one process owns the schedule, and a
 * per-league lease means one league is never synchronized twice at once. Leases expire rather than
 * being released only on a clean exit, so a worker killed mid-sweep does not hold the schedule shut.
 *
 * `huddle_acquire_lease` below is the whole implementation: one statement, so two instances racing for
 * the same key cannot both win.
 */
CREATE TABLE sync_lease (
  key          text PRIMARY KEY,
  owner        text NOT NULL,
  acquired_at  timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  CONSTRAINT sync_lease_positive_ttl CHECK (expires_at > acquired_at)
);
CREATE INDEX sync_lease_expiry_idx ON sync_lease (expires_at);

-- SETOF, so that "another owner still holds it" is no row rather than a row of nulls: the caller has to
-- handle the refusal, and cannot mistake it for a lease.
CREATE FUNCTION huddle_acquire_lease(p_key text, p_owner text, p_ttl interval, p_now timestamptz DEFAULT now())
  RETURNS SETOF sync_lease
  LANGUAGE sql AS $$
  INSERT INTO sync_lease AS lease (key, owner, acquired_at, expires_at)
  VALUES (p_key, p_owner, p_now, p_now + p_ttl)
  ON CONFLICT (key) DO UPDATE
    SET owner = excluded.owner,
        -- Renewing your own lease keeps the time you took it; taking an expired one starts afresh.
        acquired_at = CASE WHEN lease.owner = excluded.owner THEN lease.acquired_at ELSE excluded.acquired_at END,
        expires_at = excluded.expires_at
    WHERE lease.owner = excluded.owner OR lease.expires_at <= p_now
  RETURNING lease.*;
$$;
COMMENT ON FUNCTION huddle_acquire_lease(text, text, interval, timestamptz) IS
  'Returns one row when the lease was taken or renewed, and no rows when another owner still holds a live one.';

CREATE FUNCTION huddle_release_lease(p_key text, p_owner text) RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  released integer;
BEGIN
  DELETE FROM sync_lease WHERE key = p_key AND owner = p_owner;
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released;
END;
$$;

INSERT INTO schema_migrations (version, name) VALUES ('0008', 'sync_runs_and_leases');

COMMIT;
