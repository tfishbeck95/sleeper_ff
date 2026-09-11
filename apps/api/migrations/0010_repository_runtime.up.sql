-- Preserve complete weekly copies; the original schema reconstructed rosters from history.
BEGIN;
ALTER TABLE weekly_snapshot ADD COLUMN payload jsonb;
ALTER TABLE weekly_snapshot DISABLE TRIGGER weekly_snapshot_append_only;
UPDATE weekly_snapshot w SET payload = jsonb_build_object(
  'rosters', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', h.league_id || ':' || h.roster_id, 'leagueId', h.league_id, 'rosterId', h.roster_id,
    'ownerId', h.owner_id, 'coOwnerIds', h.co_owner_ids, 'playerIds', h.player_ids,
    'starterIds', h.starter_ids, 'reserveIds', h.reserve_ids, 'taxiIds', h.taxi_ids,
    'settings', h.settings, 'sourceUpdatedAt', NULL, 'synchronizedAt', h.observed_at))
    FROM roster_history h WHERE h.weekly_snapshot_id = w.id), '[]'::jsonb),
  'matchups', COALESCE((SELECT jsonb_agg(m.payload) FROM weekly_snapshot_matchup m
    WHERE m.weekly_snapshot_id = w.id), '[]'::jsonb));
ALTER TABLE weekly_snapshot ENABLE TRIGGER weekly_snapshot_append_only;
-- The repository uses opaque, caller-generated run ids, including league:timestamp.
ALTER TABLE sync_run ALTER COLUMN id TYPE text USING id::text;
-- SET NULL on the composite key previously tried to null the league primary key as well.
ALTER TABLE league DROP CONSTRAINT league_scoring_snapshot_fk;
ALTER TABLE league ADD CONSTRAINT league_scoring_snapshot_fk
  FOREIGN KEY (id, scoring_snapshot_id) REFERENCES league_scoring_snapshot (league_id, id)
  ON DELETE SET NULL (scoring_snapshot_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE dashboard_snapshot (league_id text PRIMARY KEY, payload jsonb NOT NULL);
INSERT INTO schema_migrations (version, name) VALUES ('0010', 'repository_runtime');
COMMIT;
