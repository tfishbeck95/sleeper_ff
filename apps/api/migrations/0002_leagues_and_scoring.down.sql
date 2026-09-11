-- Rollback of 0002. Drops mirrored Sleeper data, which a synchronization can rebuild, and the
-- connection set, which it cannot: connections are rebuilt from `app_user_league` on the next sweep.
BEGIN;

ALTER TABLE league DROP CONSTRAINT IF EXISTS league_scoring_snapshot_fk;
DROP TABLE IF EXISTS league_scoring_snapshot;
DROP TABLE IF EXISTS league;
DROP TABLE IF EXISTS league_connection;

DELETE FROM schema_migrations WHERE version = '0002';

COMMIT;
