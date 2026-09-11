-- 0006 forecast snapshots: one ingested, validated set of raw projected statistics.
BEGIN;

/*
 * One forecast observation from one source, for one season and week.
 *
 * `source_updated_at` is when the source says its data was current; `ingested_at` is when we observed
 * it. Conflating them is how a stale feed passes for a fresh one — a source that stops publishing
 * keeps answering with an old timestamp, and only the gap between the two reveals it. Both are stored,
 * and the freshness thresholds are applied to each separately.
 *
 * A licensed source's raw records are licensed for use but not redistribution, so rows here never
 * reach a response body: the API serves points its own boundary produced from them.
 */
CREATE TABLE forecast_snapshot (
  id                    text PRIMARY KEY,
  source                text NOT NULL,
  season                text NOT NULL CHECK (season ~ '^[0-9]{4}$'),
  week                  smallint NOT NULL CHECK (week BETWEEN 1 AND 18),
  source_updated_at     timestamptz NOT NULL,
  ingested_at           timestamptz NOT NULL,
  player_count          integer NOT NULL CHECK (player_count >= 0),
  -- The measured share of source rows that resolved to a Sleeper id. An unmatched player is silently
  -- absent from every ranking, so the figure is stored with the feed rather than only alerted on.
  identity_match_rate   numeric(5, 4) CHECK (identity_match_rate BETWEEN 0 AND 1),
  -- Fields Sleeper's contracts require that no source publishes, derived here and marked as derived
  -- rather than passed off as source data.
  derived_fields        text[] NOT NULL DEFAULT '{}',
  -- Category coverage measured against the live league's own rules, and what it did not cover.
  coverage              jsonb NOT NULL DEFAULT '{}'::jsonb,
  licenses              jsonb NOT NULL DEFAULT '[]'::jsonb,
  report                jsonb,
  CONSTRAINT forecast_snapshot_observation_unique UNIQUE (source, season, week, source_updated_at),
  -- A feed cannot have been ingested before the source published it.
  CONSTRAINT forecast_snapshot_ordering CHECK (ingested_at >= source_updated_at)
);
-- "The newest validated forecast for this week", which is what every engine asks for.
CREATE INDEX forecast_snapshot_week_idx ON forecast_snapshot (season, week, source_updated_at DESC);
-- Retention keeps the newest per week and drops the rest by age.
CREATE INDEX forecast_snapshot_ingested_idx ON forecast_snapshot (ingested_at);

/*
 * One player's raw projected statistics inside a forecast.
 *
 * Raw statistics only. A provider never supplies fantasy points, and the scoring boundary refuses a
 * pre-scored key rather than defaulting it to zero — so the same refusal is a constraint here, where
 * a hand-loaded row or a future adapter would otherwise be able to introduce one.
 */
CREATE TABLE forecast_player (
  forecast_snapshot_id  text NOT NULL REFERENCES forecast_snapshot (id) ON DELETE CASCADE,
  -- A mirrored Sleeper id: the ingestion resolved it against the directory, but the directory is
  -- replaced on its own daily cadence, so this is indexed rather than constrained.
  player_id             text NOT NULL,
  stats                 jsonb NOT NULL,
  floor_stats           jsonb,
  ceiling_stats         jsonb,
  -- Position contracts that carry every scored count themselves.
  kicker                jsonb,
  defense               jsonb,
  special_teams         jsonb,
  -- Workload, never scoring input: receptions are scored once, from `stats`.
  opportunity           jsonb,
  injury_status         text,
  opponent              text,
  bye                   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (forecast_snapshot_id, player_id),
  CONSTRAINT forecast_player_raw_stats_only CHECK (
    NOT jsonb_exists_any(stats, ARRAY['points', 'projectedPoints', 'fantasyPoints', 'projected_points', 'fantasy_points'])
    AND (floor_stats IS NULL OR NOT jsonb_exists_any(floor_stats, ARRAY['points', 'projectedPoints', 'fantasyPoints', 'projected_points', 'fantasy_points']))
    AND (ceiling_stats IS NULL OR NOT jsonb_exists_any(ceiling_stats, ARRAY['points', 'projectedPoints', 'fantasyPoints', 'projected_points', 'fantasy_points']))
  )
);
-- "Everything ever forecast for this player", across sources and weeks.
CREATE INDEX forecast_player_player_idx ON forecast_player (player_id);

CREATE TRIGGER forecast_snapshot_append_only
  BEFORE UPDATE ON forecast_snapshot
  FOR EACH ROW EXECUTE FUNCTION huddle_forbid_update();

INSERT INTO schema_migrations (version, name) VALUES ('0006', 'forecast_snapshots');

COMMIT;
