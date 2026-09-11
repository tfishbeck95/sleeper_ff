-- 0004 the shared NFL player directory and the alias map that resolves external identities onto it.
BEGIN;

/*
 * The shared player directory.
 *
 * It belongs to every league rather than to any one of them, which is why league retention never
 * touches it. A successful refresh replaces the directory wholesale, so ids Sleeper no longer
 * publishes are removed and requests for them are answered with a placeholder.
 */
CREATE TABLE player (
  id                 text PRIMARY KEY,
  first_name         text,
  last_name          text,
  full_name          text NOT NULL,
  team               text,
  position           text,
  fantasy_positions  text[] NOT NULL DEFAULT '{}',
  status             text,
  injury_status      text,
  source_updated_at  timestamptz,
  synchronized_at    timestamptz NOT NULL,
  -- The same shape ingestion validates: '0' is Sleeper's empty-starter sentinel, never a player.
  CONSTRAINT player_id_shape CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$' AND id <> '0')
);
CREATE INDEX player_name_idx ON player (lower(full_name));
CREATE INDEX player_team_position_idx ON player (team, position);
CREATE INDEX player_fantasy_positions_idx ON player USING gin (fantasy_positions);

-- Single-row table: the state of the one global directory refresh.
CREATE TABLE player_directory_state (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- The last *successful* ingestion. Retained through failures; never cleared by one.
  synchronized_at    timestamptz,
  last_attempted_at  timestamptz NOT NULL,
  -- Persisted before fetching, so a restart mid-request cannot trigger a fetch storm.
  next_attempt_at    timestamptz NOT NULL,
  last_error         text
);

/*
 * External identity to Sleeper player id.
 *
 * A mismapped identity is worse than a missing one: it attributes one player's projection to another
 * and every number downstream stays plausible. The primary key is what makes that structurally
 * impossible to store — one source's key resolves to exactly one Sleeper player, or to nothing.
 * Ambiguity is not written here; the ingestion reports it unresolved.
 */
CREATE TABLE player_alias (
  source        text NOT NULL,
  -- The source's own identifier, or a normalized `name|team|position` key for a name match.
  alias_key     text NOT NULL,
  player_id     text NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  -- Match strength, recorded so a weak match can be audited rather than trusted silently.
  alias_kind    text NOT NULL CHECK (alias_kind IN ('cross-id', 'team-defense', 'name-team-position', 'name-position')),
  display_name  text,
  team          text,
  position      text,
  observed_at   timestamptz NOT NULL,
  PRIMARY KEY (source, alias_key)
);
CREATE INDEX player_alias_player_idx ON player_alias (player_id);
-- Retention drops the aliases a source stopped publishing, one source at a time.
CREATE INDEX player_alias_source_idx ON player_alias (source, observed_at);

INSERT INTO schema_migrations (version, name) VALUES ('0004', 'players_and_aliases');

COMMIT;
