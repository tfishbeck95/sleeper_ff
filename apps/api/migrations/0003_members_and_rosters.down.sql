-- Rollback of 0003. Rosters and members are mirrored data a synchronization rebuilds; roster history
-- is not, and is gone for good. Take the backup first.
BEGIN;

DROP TABLE IF EXISTS roster_history;
DROP TABLE IF EXISTS roster_owner;
DROP TABLE IF EXISTS roster;
DROP TABLE IF EXISTS sleeper_user;

DELETE FROM schema_migrations WHERE version = '0003';

COMMIT;
