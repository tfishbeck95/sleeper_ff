-- A realistic dataset: an account links a league, the league synchronizes, and a recommendation
-- cites the scoring observation and the forecast that produced it. Every statement must succeed.
\set ON_ERROR_STOP on
-- Happy path: an account links a league, the league synchronizes, and a recommendation cites both the
-- scoring observation and the forecast it was priced from.
BEGIN;
INSERT INTO app_user (id, login, password_hash, created_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'admin', 'argon2:x', now());
INSERT INTO app_session (id_hash, user_id, family_id, created_at, expires_at, absolute_expires_at, last_rotated_at, last_seen_at)
  VALUES ('hash1', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', now(), now() + interval '2 hours', now() + interval '24 hours', now(), now());
INSERT INTO app_session_csrf (session_id_hash, csrf_hash, issued_at) VALUES ('hash1', 'csrf1', now());
INSERT INTO sleeper_account (user_id, sleeper_user_id, sleeper_username, linked_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'u1', 'manager', now());
INSERT INTO app_user_league (user_id, sleeper_league_id, linked_at)
  VALUES ('11111111-1111-1111-1111-111111111111', 'l1', now());
INSERT INTO league_connection (league_id, status, linked, season, week, created_at, updated_at, next_attempt_at)
  VALUES ('l1', 'active', true, '2026', 5, now(), now(), now() + interval '30 minutes');
-- The league cites its scoring snapshot before that snapshot is inserted: the citation is deferred.
INSERT INTO league (id, name, season, status, scoring_snapshot_id, synchronized_at)
  VALUES ('l1', 'League One', '2026', 'in_season', 'complete-live:2026-10-06T12:00:00Z:aabbccdd', now());
INSERT INTO league_scoring_snapshot (id, league_id, kind, observed_at, settings, raw_settings)
  VALUES ('complete-live:2026-10-06T12:00:00Z:aabbccdd', 'l1', 'complete-live', '2026-10-06T12:00:00Z', '{"rec":1}', '{"rec":1}');
COMMIT;

INSERT INTO sleeper_user (id, username, display_name, synchronized_at) VALUES ('u1', 'manager', 'Manager', now());
INSERT INTO player (id, full_name, team, position, fantasy_positions, synchronized_at)
  VALUES ('4034', 'Player One', 'KC', 'RB', '{RB}', now()), ('5000', 'Player Two', 'SF', 'WR', '{WR}', now());
INSERT INTO player_alias (source, alias_key, player_id, alias_kind, observed_at)
  VALUES ('sportsdataio', '17539', '4034', 'cross-id', now());
INSERT INTO roster (id, league_id, roster_id, owner_id, player_ids, starter_ids, synchronized_at)
  VALUES ('l1:1', 'l1', 1, 'u1', '{4034,5000}', '{4034}', now());
INSERT INTO roster_owner (roster_id, sleeper_user_id, role, synchronized_at) VALUES ('l1:1', 'u1', 'owner', now());
INSERT INTO matchup (id, league_id, season, week, matchup_id, roster_id, points, player_ids, starter_ids, synchronized_at)
  VALUES ('l1:2026:5:1', 'l1', '2026', 5, 1, 1, 112.4, '{4034,5000}', '{4034}', now());
INSERT INTO league_transaction (id, league_id, week, type, status, roster_ids, synchronized_at)
  VALUES ('t1', 'l1', 5, 'waiver', 'complete', '{1}', now());
INSERT INTO transaction_player (transaction_id, player_id, action, roster_id) VALUES ('t1', '5000', 'add', 1);
INSERT INTO traded_draft_pick (id, league_id, season, round, roster_id, owner_id, synchronized_at)
  VALUES ('l1:2027:1:1', 'l1', '2027', 1, 1, 2, now());
INSERT INTO weekly_snapshot (id, league_id, season, week, scoring_snapshot_id, synchronized_at)
  VALUES ('l1:2026:5:2026-10-06T12:00:00Z', 'l1', '2026', 5, 'complete-live:2026-10-06T12:00:00Z:aabbccdd', '2026-10-06T12:00:00Z');
INSERT INTO weekly_snapshot_matchup (weekly_snapshot_id, matchup_id, roster_id, payload)
  VALUES ('l1:2026:5:2026-10-06T12:00:00Z', 'l1:2026:5:1', 1, '{"points":112.4}');
INSERT INTO roster_history (id, league_id, roster_id, season, week, observed_at, owner_id, player_ids, weekly_snapshot_id)
  VALUES ('l1:1:2026-10-06T12:00:00Z', 'l1', 1, '2026', 5, '2026-10-06T12:00:00Z', 'u1', '{4034,5000}', 'l1:2026:5:2026-10-06T12:00:00Z');
INSERT INTO forecast_snapshot (id, source, season, week, source_updated_at, ingested_at, player_count, identity_match_rate)
  VALUES ('sdio:2026:5:2026-10-06T06:00:00Z', 'sportsdataio', '2026', 5, '2026-10-06T06:00:00Z', '2026-10-06T06:05:00Z', 412, 0.9812);
INSERT INTO forecast_player (forecast_snapshot_id, player_id, stats, floor_stats)
  VALUES ('sdio:2026:5:2026-10-06T06:00:00Z', '4034', '{"rush_yd":68.2,"rec":3.1}', '{"rush_yd":41.0,"rec":1.9}');
INSERT INTO recommendation (id, league_id, season, week, roster_id, kind, subject_player_id, title, rationale, confidence, projected_points, scoring_snapshot_id, forecast_snapshot_id, generated_at)
  VALUES ('33333333-3333-3333-3333-333333333333', 'l1', '2026', 5, 1, 'start', '4034', 'Start Player One', 'Highest projected eligible starter.', 0.72, 18.4, 'complete-live:2026-10-06T12:00:00Z:aabbccdd', 'sdio:2026:5:2026-10-06T06:00:00Z', now());
INSERT INTO recommendation_explanation (recommendation_id, ordinal, kind, label, detail, points)
  VALUES ('33333333-3333-3333-3333-333333333333', 0, 'contribution', 'Rushing yards', '68.2 yards at 0.1 per yard.', 6.82),
         ('33333333-3333-3333-3333-333333333333', 1, 'coverage', 'Return scoring not modelled', 'The provider does not model st_td for this player.', 0);
INSERT INTO recommendation_outcome (id, recommendation_id, observed_at, resolution, projected_points, actual_points, recorded_at)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', '2026-10-13T04:00:00Z', 'followed', 18.4, 21.7, now());
INSERT INTO sync_run (id, league_id, kind, status, season, week, started_at, finished_at, duration_ms, refreshed, worker_id)
  VALUES ('55555555-5555-5555-5555-555555555555', 'l1', 'league', 'success', '2026', 5, now() - interval '2 seconds', now(), 1840, '{league,rosters}', 'worker-a');
INSERT INTO resource_freshness (resource_key, league_id, resource, season, week, synchronized_at)
  VALUES ('rosters:l1', 'l1', 'rosters', NULL, NULL, now()), ('matchups:l1:2026:5', 'l1', 'matchups', '2026', 5, now()), ('players:nfl', NULL, 'players', NULL, NULL, now());
INSERT INTO player_directory_state (synchronized_at, last_attempted_at, next_attempt_at) VALUES (now(), now(), now() + interval '1 day');
SELECT 'happy path inserted' AS step;
