-- Rollback of 0005. Matchups, transactions and picks are re-fetchable for the current week only:
-- Sleeper serves a week at a time, and past weeks are gone with the observations that recorded them.
BEGIN;

ALTER TABLE roster_history DROP CONSTRAINT IF EXISTS roster_history_weekly_snapshot_fk;
DROP INDEX IF EXISTS roster_history_weekly_snapshot_idx;
DROP TABLE IF EXISTS weekly_snapshot_matchup;
DROP TABLE IF EXISTS weekly_snapshot;
DROP TABLE IF EXISTS traded_draft_pick;
DROP TABLE IF EXISTS transaction_draft_pick;
DROP TABLE IF EXISTS transaction_player;
DROP TABLE IF EXISTS league_transaction;
DROP TABLE IF EXISTS matchup;

DELETE FROM schema_migrations WHERE version = '0005';

COMMIT;
