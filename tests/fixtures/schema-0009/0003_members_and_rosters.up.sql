-- 0003 league members, rosters, roster ownership and roster history.
--
-- A note on foreign keys that are deliberately absent. Rows in this schema are of two kinds: rows this
-- application owns, and Sleeper ids it mirrors. Owned rows are constrained — a roster belongs to a
-- league, an owner row belongs to a roster. Mirrored ids are indexed but not constrained, because the
-- resources they name refresh on independent intervals: a roster is refreshed every five minutes and
-- the member list every six hours, so a newly added co-owner legitimately exists on a roster before
-- `sleeper_user` has heard of them. That is a freshness fact the application already reports; turning
-- it into a constraint violation would fail the synchronization that is about to fix it.
BEGIN;

CREATE TABLE sleeper_user (
  id                 text PRIMARY KEY,
  username           text NOT NULL,
  display_name       text NOT NULL,
  avatar_id          text,
  source_updated_at  timestamptz,
  synchronized_at    timestamptz NOT NULL
);
COMMENT ON COLUMN sleeper_user.id IS 'Sleeper user_id. One row per Sleeper account, enforced by the primary key.';
CREATE INDEX sleeper_user_username_idx ON sleeper_user (lower(username));

CREATE TABLE roster (
  id                 text PRIMARY KEY,
  league_id          text NOT NULL REFERENCES league (id) ON DELETE CASCADE,
  roster_id          smallint NOT NULL CHECK (roster_id > 0),
  owner_id           text,
  player_ids         text[] NOT NULL DEFAULT '{}',
  starter_ids        text[] NOT NULL DEFAULT '{}',
  reserve_ids        text[] NOT NULL DEFAULT '{}',
  taxi_ids           text[] NOT NULL DEFAULT '{}',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at  timestamptz,
  synchronized_at    timestamptz NOT NULL,
  -- Sleeper numbers rosters within a league, so the league-scoped slot is the natural key.
  CONSTRAINT roster_league_slot_unique UNIQUE (league_id, roster_id),
  CONSTRAINT roster_id_derived CHECK (id = league_id || ':' || roster_id)
);
CREATE INDEX roster_league_idx ON roster (league_id);
CREATE INDEX roster_owner_idx ON roster (owner_id);
-- "Which roster holds this player" is asked by waiver, trade and lineup analysis on every request.
CREATE INDEX roster_players_idx ON roster USING gin (player_ids);

/*
 * Roster ownership, as its own relation.
 *
 * The dashboard resolves the signed-in manager's roster by asking which roster an owner or co-owner
 * holds, which an array membership test cannot index well and a join can. Exactly one row per roster
 * is the primary owner; the rest are co-owners.
 */
CREATE TABLE roster_owner (
  roster_id        text NOT NULL REFERENCES roster (id) ON DELETE CASCADE,
  sleeper_user_id  text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner', 'co-owner')),
  synchronized_at  timestamptz NOT NULL,
  PRIMARY KEY (roster_id, sleeper_user_id)
);
CREATE INDEX roster_owner_user_idx ON roster_owner (sleeper_user_id);
CREATE UNIQUE INDEX roster_owner_single_owner_idx ON roster_owner (roster_id) WHERE role = 'owner';

/*
 * An append-only record of what a roster held when it was observed.
 *
 * Rosters themselves are mutable mirrors of the current upstream state. History is what makes a
 * recommendation reviewable after the fact: it is the only way to answer whether the player a
 * recommendation named was actually on the roster in the week it was made.
 */
CREATE TABLE roster_history (
  id                  text PRIMARY KEY,
  league_id           text NOT NULL REFERENCES league (id) ON DELETE CASCADE,
  roster_id           smallint NOT NULL,
  season              text NOT NULL CHECK (season ~ '^[0-9]{4}$'),
  week                smallint NOT NULL CHECK (week BETWEEN 1 AND 18),
  observed_at         timestamptz NOT NULL,
  owner_id            text,
  co_owner_ids        text[] NOT NULL DEFAULT '{}',
  player_ids          text[] NOT NULL DEFAULT '{}',
  starter_ids         text[] NOT NULL DEFAULT '{}',
  reserve_ids         text[] NOT NULL DEFAULT '{}',
  taxi_ids            text[] NOT NULL DEFAULT '{}',
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set in 0005, once weekly observations exist to link to.
  weekly_snapshot_id  text,
  -- The id is `<league>:<roster>:<observed at>`, so re-recording one observation is idempotent. It is
  -- not restated as a check constraint: rendering a timestamp as text depends on the session's
  -- DateStyle, and a constraint that passes for one client and fails for another is worse than none.
  CONSTRAINT roster_history_observation_unique UNIQUE (league_id, roster_id, observed_at)
);
CREATE INDEX roster_history_league_week_idx ON roster_history (league_id, season, week, observed_at DESC);
CREATE INDEX roster_history_roster_idx ON roster_history (league_id, roster_id, observed_at DESC);
CREATE INDEX roster_history_players_idx ON roster_history USING gin (player_ids);

CREATE TRIGGER roster_history_append_only
  BEFORE UPDATE ON roster_history
  FOR EACH ROW EXECUTE FUNCTION huddle_forbid_update();

INSERT INTO schema_migrations (version, name) VALUES ('0003', 'members_and_rosters');

COMMIT;
