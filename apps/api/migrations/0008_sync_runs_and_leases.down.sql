-- Rollback of 0008. Dropping the lease table removes the mutual exclusion a multi-instance deployment
-- depends on: stop every worker but one before applying it, or every instance will sweep at once.
BEGIN;

DROP FUNCTION IF EXISTS huddle_release_lease(text, text);
DROP FUNCTION IF EXISTS huddle_acquire_lease(text, text, interval, timestamptz);
DROP TABLE IF EXISTS sync_lease;
DROP TABLE IF EXISTS resource_freshness;
DROP TABLE IF EXISTS sync_run;

DELETE FROM schema_migrations WHERE version = '0008';

COMMIT;
