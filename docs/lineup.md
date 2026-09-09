# Lineup analysis and the scoring boundary

`GET /api/lineup/:leagueId?userId=<Sleeper owner or co-owner ID>&week=8&force=false`

The route uses the app's existing bearer token, synchronizes the league, then reads one consistent
league/roster/player/matchup context. Invalid weeks return 400; accounts without a roster return 403.
`/api/lineup/demo` uses a partial fictional scoring reference and therefore returns an explicitly
unavailable report — exactly what a connected league without validated live scoring receives.

## The input boundary

Forecast providers supply **raw projected statistics**, never fantasy points. The single module
`apps/api/src/projection-scoring.ts` converts them, and nothing else in the application may:

1. The synchronized league's `ScoringRules` are applied to every player's raw stat line.
2. Mean, floor and ceiling points are computed from three raw stat lines using that same rule set.
   `floorStats` and `ceilingStats` are optional; when absent, no range is estimated from the mean.
3. Each result records the **scoring snapshot ID** (`scoringSnapshotId`, derived from the observation
   timestamp and the full rule set) and the **forecast timestamp** (`forecastUpdatedAt`).
4. A projection whose raw-stat units or player identity cannot be validated is **refused**, listed in
   `rejected`, and excluded. It is never defaulted to zero and never passed through.
5. Only explicitly league-scored points reach lineup assignment and replacement-level calculations.
   `LeagueEvaluationService` re-checks each player's snapshot ID and throws if it does not match.

Refusal reasons, all reported per projection with the player named:

| `kind` | Cause |
| --- | --- |
| `identity` | The player ID matches no synchronized Sleeper player, is duplicated, or has no fantasy position. |
| `units` | A statistic this league's scoring rules do not define, or a nonfinite amount. Its unit cannot be validated. |
| `pre-scored` | A reserved key such as `points`, `projectedPoints` or `fpts`. A pre-scored total cannot be re-derived under this league's rules. |
| `coverage` | A week the caller requires has no forecast, or no explicit `bye` flag. |
| `scenario` | A floor scoring above, or a ceiling scoring below, the mean. Only that scenario is discarded; the validated mean survives. |

### Kickers

Kicker adapters must supply six distance bands of expected attempts/makes, PAT makes/misses and explicit Sleeper miss semantics for every scored scenario. Counts are normalized before this boundary applies the live scoring map. See [kicker contract, miss validation and streamer ranking](kickers.md). Generic role/matchup multipliers do not apply to kickers.

### Team defense

Team defense adapters must supply expected sacks, interceptions, forced fumbles, fumble recoveries, safeties, blocked kicks and defensive touchdowns, complete probability distributions over Sleeper's points-allowed and yards-allowed tiers, and the unit's special-teams events wherever the league scores them. Each tier enters scoring at its probability, so a threshold bonus is priced at the chance of earning it rather than granted on a favorable matchup. See [team defense contract, field mapping and streamer ranking](defense.md). Generic role/matchup multipliers do not apply to team defenses, because a multiplier would scale a probability-weighted bonus linearly with a matchup opinion.

### Individual special teams

Any non-`DEF` player may carry `specialTeams` on a week, on either supplied scenario, and on the dynasty
typical week: expected `st_td`, `st_ff` and `st_fum_rec`, plus an explicit `coverage` declaration of
which of those categories the provider models, and an optional `returnRole`. The `st_*` family pays a
rostered returner and the `def_st_*` family pays the D/ST unit, at different rates for the same real
event, so carrying either family on the other entity is refused as an identity failure and overlapping
counts within one entity are reconciled to a single canonical count.

A category the provider does not model is unknown, not zero. It contributes no points and no estimated
bonus, the league's own rate for it is read from the snapshot and reported, and the projection is marked
as having incomplete coverage. Start/sit names the gap on both sides of a comparison when a player has a
designated return role, and a league-wide absence of return modeling is disclosed once as a report
warning. Return upside adds exactly `0` to every ranking on the page: a return touchdown nobody projected
is never a reason to start the lower-scoring player. See [individual special-teams contract](special-teams.md).

### Receiving opportunity

Providers may attach `opportunity` to a week (projected targets, routes, targets per route run, route
participation, target share, red-zone targets) and `recentTargets` to a player (the observed target
count per recent game). See [waivers.md](waivers.md) for the schema and validation.

None of it becomes points. Targets are not a Sleeper scoring key, so the boundary refuses them inside
`stats`; projected receptions live in `stats.rec` and are scored once, by the league. `opportunity.ts`
derives, deterministically:

- **Reception points and their share of the total**, read back out of the already-scored
  contributions, plus what the same stat line projects under non-PPR scoring.
- **An archetype** — volume-driven, touchdown-dependent, balanced or non-receiving — from where the
  points came from.
- **Pass-catching-back identification** at 50% route participation, a 12% target share, or 3.5
  targets per week.
- **Target stability** (`1 - coefficient of variation`) and the **recent target trend** from the
  observed series, both null when too few games were supplied.

The one number that changes a projection is the **floor lift**: a *supplied* floor scenario is moved
toward its own mean by `(stability - 0.5) / 0.5 x 0.25`, capped at a quarter of the floor-to-mean gap,
and only when receptions are at least 25% of the league-scored total. The mean and ceiling never move,
a missing floor is never invented, and the lift is recorded in the week's `adjustments`. Because the
floor feeds the scenario band, a consistently targeted lineup also reports a tighter win-probability
spread — from the same bounded change, not a second one.

Start/sit uses the rest: it names each side's target stability, breaks ties on points in favour of the
steadier target share, and cautions before a swap toward a materially less stable role (a 0.15 gap) or
from a volume-driven player to a touchdown-dependent one.

Adjustments happen strictly **after** scoring and are disclosed on every value: byes and injury
windows zero a week, and `matchupMultiplier` and role trend multiply it. Waiver streaming zeroes only
the selected week for an injury designation without a supplied return week; trade valuation
conservatively zeroes the whole horizon. `ScoredWeek.mean` is always the unadjusted league-scored
result, so the adjustment is separable from the scoring.

## What the report contains

Every figure carries a sentence such as `18.4 points under your league's full-PPR scoring`, and the
major scoring contributions (`{stat, amount, rate, points}`, largest first) are available on demand.

- `lineup` — the lineup submitted in Sleeper, per slot, with its league-scored points.
- `optimal` — the best legal assignment of the same active roster. The submitted lineup is reported
  as-is and never silently rewritten.
- `startSit` — a bench player who outscores an eligible submitted starter, with the advantage, a
  confidence grade and cautions. Ranked by advantage.
- `matchup` — both submitted lineups scored under the same rules, the margin, and a win probability.
- `rosterStrength` — every roster's league-scored evaluation, position strength, exposure and
  league-relative strengths/weaknesses.
- `replacementLevels` — the first player beyond league-wide demanded starter slots, per position.
- `byeOutlook` — each remaining week's fillable starting slots, byes and league-scored total. A week
  with incomplete forecasts shows no total rather than an understated one.
- `playoffOutlook` — the configured playoff weeks, their average, and coverage risks.

### Win probability

The floor-to-ceiling band supplied by the provider is treated as roughly a 10th-to-90th percentile
interval, giving `sigma = (ceiling - floor) / 2.563` per lineup. The margin is evaluated against
`hypot(sigma_you, sigma_opponent)` through a normal CDF. This is an explainable approximation over one
supplied scenario band, not a calibrated forecast, and the explanation says so. Without floor and
ceiling stat scenarios for every starter on both lineups, the probability is `null` rather than
invented.

## Configuration

Lineup analysis reuses `WAIVER_SIGNALS_PATH` and the injectable `WaiverSignalProvider`; see
[waivers.md](waivers.md) for the complete raw-stat source schema, including the optional `floorStats`
and `ceilingStats` scenarios. Absent, wrong-season, stale (48 hours) or future-dated sources produce
an explicit unavailable report.

## Verification

`npm test`, `npm run typecheck` and `npm run build` cover every workspace. Lineup tests exercise the
scoring boundary directly (units, identity, pre-scored keys, coverage, scenario ordering, both
availability policies), submitted-versus-optimal start/sit, matchup totals and win probability, bye
and playoff outlooks, scoring-rule changes propagating to every downstream number, refused
projections, endpoint membership and errors. A source-level test asserts that no module other than
the boundary calls `ScoringRules.score`.
