-- Rollback of 0007. Nothing here can be rebuilt: a recommendation is a record of advice given at a
-- moment, under rules and a forecast that have since moved on.
BEGIN;

DROP TABLE IF EXISTS recommendation_outcome;
DROP TABLE IF EXISTS recommendation_explanation;
DROP TABLE IF EXISTS recommendation;

DELETE FROM schema_migrations WHERE version = '0007';

COMMIT;
