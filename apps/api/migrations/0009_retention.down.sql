-- Rollback of 0009. Removes the retention functions only; no data is deleted by rolling this back.
-- An installation left here retains everything until the functions are restored.
BEGIN;

DROP FUNCTION IF EXISTS huddle_apply_retention(interval, interval, interval, integer, interval, interval, interval, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_player_aliases(text, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_roster_history(interval, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_recommendations(interval, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_forecasts(interval, integer, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_sync_runs(interval, integer, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_sessions(interval, timestamptz);
DROP FUNCTION IF EXISTS huddle_prune_league(text, boolean);

DELETE FROM schema_migrations WHERE version = '0009';

COMMIT;
