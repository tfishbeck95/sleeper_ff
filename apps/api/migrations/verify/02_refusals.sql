-- One statement per constraint that has to refuse. Every statement must fail; run.sh counts the
-- refusals and fails if any of them was accepted.
\set ON_ERROR_STOP off
\pset tuples_only on
-- Each statement below MUST fail. The expected error code is named in the label.
\echo '--- duplicate Sleeper league id (23505)'
INSERT INTO league (id, name, season, status, synchronized_at) VALUES ('l1', 'Duplicate', '2026', 'in_season', now());
\echo '--- duplicate Sleeper roster slot (23505)'
INSERT INTO roster (id, league_id, roster_id, player_ids, synchronized_at) VALUES ('l1:1x', 'l1', 1, '{}', now());
\echo '--- duplicate matchup for a roster in one week (23505)'
INSERT INTO matchup (id, league_id, season, week, roster_id, points, synchronized_at) VALUES ('l1:2026:5:1', 'l1', '2026', 5, 1, 0, now());
\echo '--- duplicate weekly observation id (23505)'
INSERT INTO weekly_snapshot (id, league_id, season, week, synchronized_at) VALUES ('l1:2026:5:2026-10-06T12:00:00Z', 'l1', '2026', 5, now());
\echo '--- one external identity resolving to two players (23505)'
INSERT INTO player_alias (source, alias_key, player_id, alias_kind, observed_at) VALUES ('sportsdataio', '17539', '5000', 'cross-id', now());
\echo '--- a ranking citing another league scoring snapshot (23503)'
INSERT INTO league (id, name, season, status, synchronized_at) VALUES ('l2', 'League Two', '2026', 'in_season', now());
INSERT INTO recommendation (id, league_id, season, week, roster_id, kind, title, rationale, scoring_snapshot_id, generated_at)
  VALUES ('66666666-6666-6666-6666-666666666666', 'l2', '2026', 5, 1, 'start', 'x', 'y', 'complete-live:2026-10-06T12:00:00Z:aabbccdd', now());
\echo '--- a pre-scored key inside a raw forecast (23514)'
INSERT INTO forecast_player (forecast_snapshot_id, player_id, stats) VALUES ('sdio:2026:5:2026-10-06T06:00:00Z', '5000', '{"projectedPoints":14.2}');
\echo '--- a coverage gap carrying weight (23514)'
INSERT INTO recommendation_explanation (recommendation_id, ordinal, kind, label, detail, points)
  VALUES ('33333333-3333-3333-3333-333333333333', 2, 'coverage', 'x', 'y', 1.5);
\echo '--- updating an append-only observation (P0001)'
UPDATE weekly_snapshot SET week = 6 WHERE id = 'l1:2026:5:2026-10-06T12:00:00Z';
\echo '--- updating a recorded outcome (P0001)'
UPDATE recommendation_outcome SET actual_points = 99 WHERE id = '44444444-4444-4444-4444-444444444444';
\echo '--- an archived connection that is still scheduled (23514)'
INSERT INTO league_connection (league_id, status, linked, created_at, updated_at, archived_at, archived_reason, next_attempt_at)
  VALUES ('l3', 'archived', false, now(), now(), now(), 'unlinked', now());
\echo '--- an idle deadline past the absolute one (23514)'
INSERT INTO app_session (id_hash, user_id, family_id, created_at, expires_at, absolute_expires_at, last_rotated_at, last_seen_at)
  VALUES ('hash2', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', now(), now() + interval '48 hours', now() + interval '24 hours', now(), now());
\echo '--- a mixed-case login sign-in can never match (23514)'
INSERT INTO app_user (id, login, password_hash, created_at) VALUES ('77777777-7777-7777-7777-777777777777', 'Admin', 'x', now());
\echo '--- pruning a league someone still links (23514)'
SELECT huddle_prune_league('l1');
\echo '--- the empty-starter sentinel as a player (23514)'
INSERT INTO player (id, full_name, synchronized_at) VALUES ('0', 'Empty', now());
\echo '--- a failed run with no category (23514)'
INSERT INTO sync_run (id, league_id, kind, status, started_at, finished_at, duration_ms)
  VALUES ('88888888-8888-8888-8888-888888888888', 'l1', 'league', 'failed', now(), now(), 10);
