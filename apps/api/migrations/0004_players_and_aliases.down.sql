-- Rollback of 0004. The directory and its aliases are both rebuildable: the directory from Sleeper,
-- the aliases from the next identity-map ingestion.
BEGIN;

DROP TABLE IF EXISTS player_alias;
DROP TABLE IF EXISTS player_directory_state;
DROP TABLE IF EXISTS player;

DELETE FROM schema_migrations WHERE version = '0004';

COMMIT;
