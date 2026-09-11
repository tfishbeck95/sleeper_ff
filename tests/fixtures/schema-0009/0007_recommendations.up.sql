-- 0007 recommendations, the explanations that justify them, and the outcomes that grade them.
BEGIN;

/*
 * One recommendation, with the provenance that makes it reviewable.
 *
 * The scoring citation is a composite foreign key onto `(league_id, id)` rather than onto the snapshot
 * id alone, which is the fail-closed rule from the evaluation service expressed as a constraint:
 * points scored under one commissioner's rules can never rank another league, and a row that tried to
 * claim otherwise cannot be stored. Both citations are deferred, so a recommendation and the
 * observations it cites can be written in one unit of work in any order.
 */
CREATE TABLE recommendation (
  id                    uuid PRIMARY KEY,
  league_id             text NOT NULL REFERENCES league (id) ON DELETE CASCADE,
  season                text NOT NULL CHECK (season ~ '^[0-9]{4}$'),
  week                  smallint NOT NULL CHECK (week BETWEEN 1 AND 18),
  roster_id             smallint NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('start', 'sit', 'waiver', 'trade', 'streamer')),
  -- Mirrored Sleeper ids: the player a recommendation is about, and the one it would move out.
  subject_player_id     text,
  counterpart_player_id text,
  title                 text NOT NULL,
  rationale             text NOT NULL,
  confidence            numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  -- League-scored points, produced by the scoring boundary from raw statistics. Never a source value.
  projected_points      numeric(8, 2),
  scoring_snapshot_id   text NOT NULL,
  forecast_snapshot_id  text,
  generated_at          timestamptz NOT NULL,
  -- The engine report as served, so a review sees what the manager saw.
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT recommendation_scoring_fk FOREIGN KEY (league_id, scoring_snapshot_id)
    REFERENCES league_scoring_snapshot (league_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT recommendation_forecast_fk FOREIGN KEY (forecast_snapshot_id)
    REFERENCES forecast_snapshot (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX recommendation_league_week_idx ON recommendation (league_id, season, week, generated_at DESC);
CREATE INDEX recommendation_roster_idx ON recommendation (league_id, roster_id, week, generated_at DESC);
-- "Everything this application ever advised about this player."
CREATE INDEX recommendation_subject_idx ON recommendation (subject_player_id) WHERE subject_player_id IS NOT NULL;
CREATE INDEX recommendation_forecast_idx ON recommendation (forecast_snapshot_id) WHERE forecast_snapshot_id IS NOT NULL;
CREATE INDEX recommendation_generated_idx ON recommendation (generated_at);

/*
 * The itemized reasoning behind one recommendation, in the order it is shown.
 *
 * Scoring contributions and post-scoring adjustments are separate kinds because they are separate
 * things: the first is what the league's rules paid, the second is what this application did with
 * that afterwards, and collapsing them is how a manager loses the ability to check either.
 */
CREATE TABLE recommendation_explanation (
  recommendation_id  uuid NOT NULL REFERENCES recommendation (id) ON DELETE CASCADE,
  ordinal            smallint NOT NULL CHECK (ordinal >= 0),
  kind               text NOT NULL CHECK (kind IN ('scoring', 'contribution', 'adjustment', 'risk', 'coverage', 'alternative')),
  label              text NOT NULL,
  detail             text NOT NULL,
  points             numeric(8, 2),
  PRIMARY KEY (recommendation_id, ordinal),
  -- A coverage gap is a disclosure, not a score. A category the provider does not model contributes
  -- exactly zero: it may never promote the player it concerns, and may never demote one either.
  CONSTRAINT recommendation_explanation_coverage_is_weightless
    CHECK (kind <> 'coverage' OR points IS NULL OR points = 0)
);

/*
 * What actually happened.
 *
 * One recommendation can be observed more than once — Sleeper corrects statistics after the fact, and
 * a corrected week is a new observation rather than an edit of the old one. `resolution` records
 * whether the manager took the advice at all, because a recommendation nobody followed says nothing
 * about whether it was right.
 */
CREATE TABLE recommendation_outcome (
  id                     uuid PRIMARY KEY,
  recommendation_id      uuid NOT NULL REFERENCES recommendation (id) ON DELETE CASCADE,
  observed_at            timestamptz NOT NULL,
  resolution             text NOT NULL CHECK (resolution IN ('followed', 'not-followed', 'unknown', 'expired')),
  projected_points       numeric(8, 2),
  actual_points          numeric(8, 2),
  -- What the alternative scored, where there was one: the difference the advice actually made.
  counterfactual_points  numeric(8, 2),
  -- The rules the actual points were scored under, which is not necessarily the rules that produced
  -- the projection: a commissioner can change scoring mid-week, and comparing across that is invalid.
  scoring_snapshot_id    text,
  note                   text,
  recorded_at            timestamptz NOT NULL,
  CONSTRAINT recommendation_outcome_observation_unique UNIQUE (recommendation_id, observed_at),
  -- An outcome that says the advice was followed has to say what it scored.
  CONSTRAINT recommendation_outcome_followed_is_scored
    CHECK (resolution <> 'followed' OR actual_points IS NOT NULL)
);
CREATE INDEX recommendation_outcome_recommendation_idx ON recommendation_outcome (recommendation_id, observed_at DESC);
CREATE INDEX recommendation_outcome_observed_idx ON recommendation_outcome (observed_at);

CREATE TRIGGER recommendation_outcome_append_only
  BEFORE UPDATE ON recommendation_outcome
  FOR EACH ROW EXECUTE FUNCTION huddle_forbid_update();

INSERT INTO schema_migrations (version, name) VALUES ('0007', 'recommendations');

COMMIT;
