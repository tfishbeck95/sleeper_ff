-- 0002 connected leagues, mirrored league metadata, and the scoring snapshots every ranking cites.
BEGIN;

/*
 * One connected league and the week it is being synchronized for.
 *
 * This is the scheduling entity, not a child of `league`: reconciliation creates a connection from the
 * leagues the accounts link, and the league's own metadata only arrives on its first successful
 * synchronization. So a connection deliberately carries no foreign key to `league`.
 */
CREATE TABLE league_connection (
  league_id             text PRIMARY KEY,
  -- The sample league is a development affordance and is never scheduled in production.
  demo                  boolean NOT NULL DEFAULT false,
  status                text NOT NULL CHECK (status IN ('active', 'archived')),
  -- True while at least one account still links the league. Pruning requires false.
  linked                boolean NOT NULL DEFAULT false,
  season                text CHECK (season ~ '^[0-9]{4}$'),
  -- Persisted so a restart resumes the week it left off on rather than re-deriving it.
  week                  smallint CHECK (week BETWEEN 1 AND 18),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  archived_at           timestamptz,
  archived_reason       text,
  last_attempted_at     timestamptz,
  -- Retained through failures: the last good synchronization is what the dashboard keeps serving.
  last_synced_at        timestamptz,
  last_status           text CHECK (last_status IN ('success', 'failed')),
  last_category         text,
  last_duration_ms      integer CHECK (last_duration_ms >= 0),
  last_refreshed        text[] NOT NULL DEFAULT '{}',
  resource_freshness    jsonb NOT NULL DEFAULT '{}'::jsonb,
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- Authoritative for scheduling: upstream's own Retry-After when Sleeper sent one, this worker's
  -- backoff when it did not.
  next_attempt_at       timestamptz,
  CONSTRAINT league_connection_archived_complete CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT league_connection_archived_reason CHECK (status = 'active' OR archived_reason IS NOT NULL),
  -- An archived league is not scheduled. Storing a next attempt for one would reintroduce exactly the
  -- fan-out the retention policy exists to stop.
  CONSTRAINT league_connection_archived_not_scheduled CHECK (status = 'active' OR next_attempt_at IS NULL),
  CONSTRAINT league_connection_failure_category CHECK (last_status IS DISTINCT FROM 'failed' OR last_category IS NOT NULL)
);
-- The sweep asks for active connections that are due, in that order.
CREATE INDEX league_connection_due_idx ON league_connection (next_attempt_at) WHERE status = 'active';
-- Retention asks for archived connections nobody links any more.
CREATE INDEX league_connection_prune_idx ON league_connection (archived_at) WHERE status = 'archived' AND NOT linked;

CREATE TABLE league (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  season              text NOT NULL CHECK (season ~ '^[0-9]{4}$'),
  status              text NOT NULL,
  previous_league_id  text,
  total_rosters       smallint CHECK (total_rosters > 0),
  roster_positions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Sleeper's numeric league settings, retained so rules are interpreted rather than guessed.
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  season_type         text,
  -- The scoring observation currently in force. Points a projection carries must cite this id.
  scoring_snapshot_id text,
  source_updated_at   timestamptz,
  synchronized_at     timestamptz NOT NULL
);
COMMENT ON COLUMN league.id IS 'Sleeper league_id. One row per Sleeper league: the primary key is the unique constraint on it.';
CREATE INDEX league_season_idx ON league (season);

/*
 * One validated observation of a league's scoring rules.
 *
 * The id is the application's own `scoringSnapshotId`, derived from the observation's kind, timestamp
 * and rule set. It is unique within its league rather than globally: two leagues can legitimately
 * observe identical rules at the same instant, and that is not a collision worth failing a
 * synchronization over. Scoping it to the league is also what lets the citation foreign keys below
 * prove a ranking was priced by *this* league's rules — the same fail-closed check the evaluation
 * service performs in memory.
 */
CREATE TABLE league_scoring_snapshot (
  id                 text NOT NULL,
  league_id          text NOT NULL REFERENCES league (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('complete-live', 'partial-reference', 'unavailable')),
  -- Null only for a reference observation that was never synchronized.
  observed_at        timestamptz,
  last_attempted_at  timestamptz,
  -- Validated numeric rules. Null exactly when the observation is unavailable.
  settings           jsonb,
  -- The exact upstream representation, including unrecognized keys and invalid values.
  raw_settings       jsonb,
  issues             jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, id),
  CONSTRAINT league_scoring_settings_presence CHECK ((kind = 'unavailable') = (settings IS NULL)),
  -- One row per distinct observation of one league's rules.
  CONSTRAINT league_scoring_observation_unique UNIQUE (league_id, kind, observed_at)
);
-- Rankings look the current snapshot up by id; retention and the UI read the newest per league.
CREATE INDEX league_scoring_snapshot_league_idx ON league_scoring_snapshot (league_id, observed_at DESC);

-- Deferred because a league and the snapshot it points at are written in the same unit of work, in
-- whichever order the adapter finds convenient.
ALTER TABLE league
  ADD CONSTRAINT league_scoring_snapshot_fk
  FOREIGN KEY (id, scoring_snapshot_id) REFERENCES league_scoring_snapshot (league_id, id)
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Observations of a commissioner's rules are history, not a mutable current value.
CREATE TRIGGER league_scoring_snapshot_append_only
  BEFORE UPDATE ON league_scoring_snapshot
  FOR EACH ROW EXECUTE FUNCTION huddle_forbid_update();

INSERT INTO schema_migrations (version, name) VALUES ('0002', 'leagues_and_scoring');

COMMIT;
