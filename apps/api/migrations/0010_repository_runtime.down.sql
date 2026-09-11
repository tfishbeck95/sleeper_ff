BEGIN;
DROP TABLE IF EXISTS dashboard_snapshot;
ALTER TABLE weekly_snapshot DROP COLUMN payload;
-- Run ids remain text: narrowing opaque ids to UUID would discard post-upgrade history.
DELETE FROM schema_migrations WHERE version = '0010';
COMMIT;
