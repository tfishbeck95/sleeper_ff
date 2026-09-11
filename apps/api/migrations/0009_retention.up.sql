-- 0009 retention.
--
-- Two kinds of rule are deliberately kept apart. The rules here are about storage: how long a row is
-- worth keeping once nothing refers to it. The rule about whether a league's season can still change
-- stays in the worker, where the NFL calendar already lives — duplicating it in SQL would give an
-- installation two calendars that can disagree.
--
-- Every function below is conservative in the direction that keeps data, and none of them is on a
-- schedule of its own: the worker calls them, so a stopped worker deletes nothing.
BEGIN;

/*
 * Deletes one league's stored data and its connection.
 *
 * The guard is the policy, not a convenience: data is only ever removed from a league that has been
 * archived and that no account still links. An operator who genuinely means to delete a live league's
 * data passes p_force, and has to say so.
 *
 * The shared player directory is untouched by design — it belongs to every league.
 */
CREATE FUNCTION huddle_prune_league(p_league_id text, p_force boolean DEFAULT false) RETURNS bigint
  LANGUAGE plpgsql AS $$
DECLARE
  connection league_connection%ROWTYPE;
  removed bigint := 0;
BEGIN
  SELECT * INTO connection FROM league_connection WHERE league_id = p_league_id FOR UPDATE;
  IF NOT p_force AND FOUND AND (connection.status <> 'archived' OR connection.linked) THEN
    RAISE EXCEPTION 'league % is % and %linked; pruning requires an archived, unlinked league',
      p_league_id, connection.status, CASE WHEN connection.linked THEN '' ELSE 'un' END
      USING ERRCODE = 'check_violation';
  END IF;

  -- `league` cascades to scoring snapshots, rosters, roster history, matchups, transactions, picks,
  -- weekly observations, recommendations and freshness; `league_connection` cascades to sync runs.
  WITH deleted AS (DELETE FROM league WHERE id = p_league_id RETURNING 1)
  SELECT count(*) INTO removed FROM deleted;
  WITH deleted AS (DELETE FROM league_connection WHERE league_id = p_league_id RETURNING 1)
  SELECT removed + count(*) INTO removed FROM deleted;
  -- Freshness rows for a league that was never successfully synchronized have no `league` row to
  -- cascade from, so they are removed by key.
  WITH deleted AS (DELETE FROM resource_freshness WHERE league_id = p_league_id RETURNING 1)
  SELECT removed + count(*) INTO removed FROM deleted;
  RETURN removed;
END;
$$;

/* Sessions are dropped once they can no longer authenticate anything, plus a grace window. */
CREATE FUNCTION huddle_prune_sessions(p_retention interval DEFAULT interval '7 days', p_now timestamptz DEFAULT now())
  RETURNS bigint LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM app_session
    WHERE greatest(absolute_expires_at, expires_at, coalesce(revoked_at, '-infinity'::timestamptz)) < p_now - p_retention
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/*
 * Attempts age out, but a league always keeps its most recent ones however old they are: the last
 * thing that happened to a league that stopped being synchronized in October is exactly what someone
 * needs in March.
 */
CREATE FUNCTION huddle_prune_sync_runs(p_retention interval DEFAULT interval '30 days', p_keep_per_league integer DEFAULT 100, p_now timestamptz DEFAULT now())
  RETURNS bigint LANGUAGE sql AS $$
  WITH ranked AS (
    SELECT id, started_at,
           row_number() OVER (PARTITION BY coalesce(league_id, kind) ORDER BY started_at DESC) AS recency
    FROM sync_run
  ), deleted AS (
    DELETE FROM sync_run
    WHERE id IN (SELECT id FROM ranked WHERE recency > p_keep_per_league AND started_at < p_now - p_retention)
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/*
 * Forecasts age out, except the newest per week — which is what a late review of a week reads — and
 * except any a retained recommendation still cites. A citation that outlived what it cites is not a
 * saving; it is a recommendation nobody can check.
 */
CREATE FUNCTION huddle_prune_forecasts(p_retention interval DEFAULT interval '90 days', p_keep_per_week integer DEFAULT 1, p_now timestamptz DEFAULT now())
  RETURNS bigint LANGUAGE sql AS $$
  WITH ranked AS (
    SELECT id, ingested_at,
           row_number() OVER (PARTITION BY source, season, week ORDER BY source_updated_at DESC) AS recency
    FROM forecast_snapshot
  ), deleted AS (
    DELETE FROM forecast_snapshot
    WHERE id IN (SELECT id FROM ranked WHERE recency > p_keep_per_week AND ingested_at < p_now - p_retention)
      AND id NOT IN (SELECT forecast_snapshot_id FROM recommendation WHERE forecast_snapshot_id IS NOT NULL)
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/*
 * Recommendations age out once they and their outcomes are old enough. Explanations and outcomes go
 * with them by cascade, because an explanation of advice nobody can read is not evidence of anything.
 */
CREATE FUNCTION huddle_prune_recommendations(p_retention interval DEFAULT interval '2 years', p_now timestamptz DEFAULT now())
  RETURNS bigint LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM recommendation r
    WHERE r.generated_at < p_now - p_retention
      AND NOT EXISTS (
        SELECT 1 FROM recommendation_outcome o
        WHERE o.recommendation_id = r.id AND o.observed_at >= p_now - p_retention
      )
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/* Roster history thins to one observation per roster per week once it is old enough to review. */
CREATE FUNCTION huddle_prune_roster_history(p_retention interval DEFAULT interval '1 year', p_now timestamptz DEFAULT now())
  RETURNS bigint LANGUAGE sql AS $$
  WITH ranked AS (
    SELECT id, observed_at,
           row_number() OVER (PARTITION BY league_id, roster_id, season, week ORDER BY observed_at DESC) AS recency
    FROM roster_history
  ), deleted AS (
    DELETE FROM roster_history
    WHERE id IN (SELECT id FROM ranked WHERE recency > 1 AND observed_at < p_now - p_retention)
    RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/* Aliases a source has stopped publishing. Scoped to one source: an ingestion failure elsewhere must
   not look like a source that dropped a player. */
CREATE FUNCTION huddle_prune_player_aliases(p_source text, p_before timestamptz)
  RETURNS bigint LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM player_alias WHERE source = p_source AND observed_at < p_before RETURNING 1
  )
  SELECT count(*) FROM deleted;
$$;

/*
 * One pass of every storage retention rule, reporting what each removed.
 *
 * League pruning is applied to archived, unlinked connections only, which is the same policy
 * `huddle_prune_league` enforces on its own.
 */
CREATE FUNCTION huddle_apply_retention(
  p_prune_after interval DEFAULT interval '180 days',
  p_session_retention interval DEFAULT interval '7 days',
  p_sync_run_retention interval DEFAULT interval '30 days',
  p_sync_runs_per_league integer DEFAULT 100,
  p_forecast_retention interval DEFAULT interval '90 days',
  p_recommendation_retention interval DEFAULT interval '2 years',
  p_roster_history_retention interval DEFAULT interval '1 year',
  p_now timestamptz DEFAULT now()
) RETURNS TABLE (scope text, removed bigint)
  LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
  leagues bigint := 0;
  league_rows bigint := 0;
BEGIN
  FOR candidate IN
    SELECT league_id FROM league_connection
    WHERE status = 'archived' AND NOT linked AND archived_at < p_now - p_prune_after
  LOOP
    league_rows := league_rows + huddle_prune_league(candidate);
    leagues := leagues + 1;
  END LOOP;

  RETURN QUERY SELECT 'leagues'::text, leagues;
  RETURN QUERY SELECT 'league_rows'::text, league_rows;
  RETURN QUERY SELECT 'sessions'::text, huddle_prune_sessions(p_session_retention, p_now);
  RETURN QUERY SELECT 'sync_runs'::text, huddle_prune_sync_runs(p_sync_run_retention, p_sync_runs_per_league, p_now);
  RETURN QUERY SELECT 'forecasts'::text, huddle_prune_forecasts(p_forecast_retention, 1, p_now);
  RETURN QUERY SELECT 'recommendations'::text, huddle_prune_recommendations(p_recommendation_retention, p_now);
  RETURN QUERY SELECT 'roster_history'::text, huddle_prune_roster_history(p_roster_history_retention, p_now);
END;
$$;

INSERT INTO schema_migrations (version, name) VALUES ('0009', 'retention');

COMMIT;
