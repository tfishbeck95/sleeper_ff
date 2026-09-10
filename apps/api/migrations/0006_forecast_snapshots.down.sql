-- Rollback of 0006. A licensed feed can be re-ingested for the current week only; earlier weeks are
-- gone, and with them the ability to score any recommendation that cited them.
BEGIN;

DROP TABLE IF EXISTS forecast_player;
DROP TABLE IF EXISTS forecast_snapshot;

DELETE FROM schema_migrations WHERE version = '0006';

COMMIT;
