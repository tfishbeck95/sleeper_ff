-- Rollback of 0001. Destroys every application account and session: see the rollback procedure in
-- docs/data-durability.md, which requires a verified backup before a down migration that drops data.
BEGIN;

DROP TABLE IF EXISTS app_user_league;
DROP TABLE IF EXISTS sleeper_account;
DROP TABLE IF EXISTS app_session_csrf;
DROP TABLE IF EXISTS app_session;
DROP TABLE IF EXISTS app_user;
DROP FUNCTION IF EXISTS huddle_forbid_update();

DELETE FROM schema_migrations WHERE version = '0001';

COMMIT;
