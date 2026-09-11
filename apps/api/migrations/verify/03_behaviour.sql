-- Behaviour rather than shape: lease mutual exclusion, transactional replacement of an authoritative
-- set, the retention rules, and the league/week/player access paths using their indexes.
\set ON_ERROR_STOP on
\pset tuples_only off
-- Leases: one owner wins, the loser gets no row at all, an expired lease is takeable, and a renewal
-- keeps its original acquisition time.
SELECT 'worker-a takes it' AS step, count(*) AS rows FROM huddle_acquire_lease('league-sync:sweep', 'worker-a', interval '10 minutes');
SELECT 'worker-b is refused' AS step, count(*) AS rows FROM huddle_acquire_lease('league-sync:sweep', 'worker-b', interval '10 minutes');
SELECT 'worker-a renews, keeping acquired_at' AS step,
       (SELECT acquired_at FROM huddle_acquire_lease('league-sync:sweep', 'worker-a', interval '20 minutes'))
       = (SELECT acquired_at FROM sync_lease WHERE key = 'league-sync:sweep') AS kept;
SELECT 'worker-b takes an expired lease' AS step, count(*) AS rows
  FROM huddle_acquire_lease('league-sync:sweep', 'worker-b', interval '10 minutes', now() + interval '21 minutes');
SELECT 'release is owner scoped' AS step, huddle_release_lease('league-sync:sweep', 'worker-a') AS released_by_wrong_owner;

-- Replacing an authoritative set: a returned pick must not keep its old owner. Both statements are one
-- transaction, so no reader ever sees a league with no picks at all.
BEGIN;
DELETE FROM traded_draft_pick WHERE league_id = 'l1';
INSERT INTO traded_draft_pick (id, league_id, season, round, roster_id, owner_id, synchronized_at)
  VALUES ('l1:2027:2:1', 'l1', '2027', 2, 1, 3, now());
COMMIT;
SELECT 'picks replaced' AS step, string_agg(id, ',') AS remaining FROM traded_draft_pick WHERE league_id = 'l1';

-- Retention leaves a linked league alone and prunes an archived, unlinked one, cascading its children.
INSERT INTO league_connection (league_id, status, linked, created_at, updated_at, archived_at, archived_reason)
  VALUES ('l9', 'archived', false, now(), now(), now() - interval '200 days', 'unlinked');
INSERT INTO league (id, name, season, status, synchronized_at) VALUES ('l9', 'Old League', '2024', 'complete', now());
INSERT INTO roster (id, league_id, roster_id, player_ids, synchronized_at) VALUES ('l9:1', 'l9', 1, '{4034}', now());
INSERT INTO matchup (id, league_id, season, week, roster_id, points, synchronized_at) VALUES ('l9:2024:5:1', 'l9', '2024', 5, 1, 88.0, now());
INSERT INTO resource_freshness (resource_key, league_id, resource, synchronized_at) VALUES ('rosters:l9', 'l9', 'rosters', now());
INSERT INTO sync_run (id, league_id, kind, status, started_at, finished_at, duration_ms)
  VALUES ('99999999-9999-9999-9999-999999999999', 'l9', 'league', 'success', now(), now(), 5);
-- A session that expired long ago, a stale forecast nothing cites, and a stale forecast a retained
-- recommendation does cite.
INSERT INTO app_session (id_hash, user_id, family_id, created_at, expires_at, absolute_expires_at, last_rotated_at, last_seen_at, revoked_at, revoked_reason)
  VALUES ('hash-old', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          now() - interval '40 days', now() - interval '39 days', now() - interval '39 days', now() - interval '40 days', now() - interval '39 days', now() - interval '39 days', 'expired');
INSERT INTO forecast_snapshot (id, source, season, week, source_updated_at, ingested_at, player_count)
  VALUES ('sdio:2026:5:uncited', 'sportsdataio', '2026', 5, now() - interval '200 days', now() - interval '200 days', 400),
         ('sdio:2026:5:cited', 'sportsdataio', '2026', 5, now() - interval '201 days', now() - interval '201 days', 400);
INSERT INTO recommendation (id, league_id, season, week, roster_id, kind, title, rationale, scoring_snapshot_id, forecast_snapshot_id, generated_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'l1', '2026', 5, 1, 'waiver', 'Old advice', 'Cites an old forecast.',
          'complete-live:2026-10-06T12:00:00Z:aabbccdd', 'sdio:2026:5:cited', now() - interval '200 days');

SELECT * FROM huddle_apply_retention();
SELECT 'linked league retained' AS step, count(*) AS leagues FROM league WHERE id = 'l1';
SELECT 'pruned league gone' AS step,
       (SELECT count(*) FROM league WHERE id = 'l9') AS leagues,
       (SELECT count(*) FROM roster WHERE league_id = 'l9') AS rosters,
       (SELECT count(*) FROM matchup WHERE league_id = 'l9') AS matchups,
       (SELECT count(*) FROM resource_freshness WHERE league_id = 'l9') AS freshness,
       (SELECT count(*) FROM sync_run WHERE league_id = 'l9') AS runs,
       (SELECT count(*) FROM league_connection WHERE league_id = 'l9') AS connections;
SELECT 'shared directory untouched' AS step, count(*) AS players FROM player;
SELECT 'uncited stale forecast dropped, cited one kept' AS step,
       (SELECT count(*) FROM forecast_snapshot WHERE id = 'sdio:2026:5:uncited') AS uncited,
       (SELECT count(*) FROM forecast_snapshot WHERE id = 'sdio:2026:5:cited') AS cited;
-- League/week and player access paths use their indexes rather than a sequential scan.
SET enable_seqscan = off;
EXPLAIN (COSTS off) SELECT * FROM matchup WHERE league_id = 'l1' AND season = '2026' AND week = 5;
EXPLAIN (COSTS off) SELECT * FROM roster WHERE player_ids @> ARRAY['4034'];
EXPLAIN (COSTS off) SELECT * FROM transaction_player WHERE player_id = '5000';
RESET enable_seqscan;
