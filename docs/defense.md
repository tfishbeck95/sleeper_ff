# Team defense forecast contract and streaming

Team defense / special teams (`DEF`) forecasts use the same validated complete live Sleeper scoring snapshot as every other position. No reference scoring, team reputation, consensus rank or "good matchup" enables a projection. The synchronized player directory identifies the unit; every `DEF` weekly mean, supplied floor/ceiling and dynasty typical week must carry the contract below. Missing or inconsistent detail refuses that unit's forecast and excludes it from ranking instead of substituting zero.

## Threshold bonuses are probabilities, not matchup opinions

Sleeper's points-allowed and yards-allowed rules are all-or-nothing: a shutout pays `pts_allow_0` in full, and one point allowed pays nothing. The failure mode this contract exists to prevent is granting that bonus — or a scaled share of it — because a defense "has a great matchup".

Instead the adapter supplies a **complete probability distribution** over each Sleeper tier, and the scoring boundary enters each tier's probability as its raw amount. The league's own rate then prices it: a 6% shutout chance against the local synchronized map's `pts_allow_0 = 8` contributes `0.06 × 8 = 0.48` points. The full 8 points are reachable only from a point-mass distribution — a forecast that asserts a shutout is certain. Every intermediate matchup lands in between, linearly and visibly.

The same holds for yards: `yds_allow_0_100 = 3` in the synchronized map is the "fewer than 100 total yards allowed" bonus, and it enters as `P(under 100 yards) × 3`.

Because a blanket multiplier would scale a probability-weighted bonus linearly with a matchup opinion, **generic role and non-neutral matchup multipliers are refused for `DEF`**, exactly as they are for kickers. Opponent effects belong in the counts, the tier probabilities, or the disclosed ranking context — never in a factor applied after scoring.

## Field mapping

Key names and rates come from the selected league's own `scoring_settings` response. The captured live map in `packages/domain/src/fixtures/league-scoring.ts` and the transcribed reference in `docs/league-scoring-rules.txt` agree on the three families below, which the contract keeps strictly apart.

| Forecast field | Sleeper key | Scope |
| --- | --- | --- |
| `sacks` | `sack` | Team defense |
| `interceptions` | `int` | Team defense — never the quarterback's `pass_int` |
| `forcedFumbles` | `ff` | Team defense |
| `fumbleRecoveries` | `fum_rec` | Team defense |
| `safeties` | `safe` | Team defense |
| `blockedKicks` | `blk_kick` | Team defense |
| `defensiveTouchdowns` | `def_td` | Team defense |
| `pointsAllowed.buckets.<tier>` | `pts_allow_<tier>` | Team defense, probability-weighted |
| `yardsAllowed.buckets.<tier>` | `yds_allow_<tier>` | Team defense, probability-weighted |
| `pointsAllowed.expected` | `pts_allow` | Only when the league scores per point allowed |
| `yardsAllowed.expected` | `yds_allow` | Only when the league scores per yard allowed |
| `specialTeams.touchdowns` | `def_st_td` | The unit's special teams |
| `specialTeams.forcedFumbles` | `def_st_ff` | The unit's special teams |
| `specialTeams.fumbleRecoveries` | `def_st_fum_rec` | The unit's special teams |

`st_td`, `st_ff`, `st_fum_rec` and `st_tkl_solo` are the **individual** special-teams rules a rostered returner scores on their own stat line. They are never written by a team forecast, and supplying one inside a `DEF` stat line is refused with that explanation. This matters because the live map prices them differently: `def_st_fum_rec` is 1 and `st_fum_rec` is 2, so collapsing the two would silently double a return unit's fumble value.

### Forced fumbles and recoveries are separate events

`ff` and `fum_rec` are independent Sleeper rules and independent forecast fields. Neither is derived from the other, and neither constrains the other:

- A fumble the defense forces **and** recovers scores both rules. It is two events.
- A defense can force a fumble the offense recovers, so forced fumbles can exceed recoveries.
- A defense can recover a fumble it never forced — an aborted snap, a muffed exchange — so recoveries can exceed forced fumbles.

The same separation applies to `def_st_ff` and `def_st_fum_rec` on special teams.

## Adapter example

Within an existing weekly forecast, `stats` can be empty when all scoring counts come from `defense`:

```json
{
  "week": 8,
  "bye": false,
  "opponent": "OPP",
  "stats": {},
  "defense": {
    "sacks": 2.5,
    "interceptions": 0.8,
    "forcedFumbles": 0.9,
    "fumbleRecoveries": 0.6,
    "safeties": 0.05,
    "blockedKicks": 0.1,
    "defensiveTouchdowns": 0.25,
    "pointsAllowed": {
      "buckets": { "0": 0.06, "1_6": 0.12, "7_13": 0.24, "14_20": 0.28, "21_27": 0.18, "28_34": 0.08, "35p": 0.04 },
      "expected": 17.4
    },
    "yardsAllowed": {
      "buckets": { "0_100": 0.04, "100_199": 0.1, "200_299": 0.26, "300_349": 0.2, "350_399": 0.18, "400_449": 0.12, "450_499": 0.06, "500_549": 0.03, "550p": 0.01 },
      "expected": 318
    },
    "specialTeams": { "touchdowns": 0.05, "forcedFumbles": 0.15, "fumbleRecoveries": 0.1 },
    "context": {
      "includedInForecast": true,
      "opponentPressure": { "sackRateAllowed": 0.082, "pressureRateAllowed": 0.27 },
      "opponentTurnovers": { "interceptionRate": 0.031, "fumbleRate": 0.018 },
      "opponentOffensiveLine": { "startersOut": 2, "continuity": 0.6 },
      "opponentQuarterback": { "status": "backup", "name": "Example backup" },
      "specialTeams": { "returnOpportunities": 5.5, "opponentReturnYardsAllowed": 11.2, "opponentMuffRate": 0.02 }
    }
  }
}
```

This example is illustrative, not a live forecast. Counts are nonnegative single-game expectations with plausibility ceilings, so a season total passed as a weekly line is refused rather than ranked.

Both tier distributions are complete: every tier is explicit, including zero, and the probabilities sum to 1 within 0.000001. `expected` is optional, and when supplied it must be reachable from its own distribution — checked against the inclusive bounds of each tier — so an optimistic tier set cannot be paired with a pessimistic mean or the reverse. When the league scores `pts_allow` or `yds_allow` per point or yard, that mean becomes **required**: a tier midpoint is never substituted.

Overlapping counts inside `stats` are alternate descriptions of the same events, never quantities to add. A duplicate must agree within 0.000001 or the forecast is refused. Tier keys the league does not define are dropped during normalization rather than pushed at the shared raw-stat unit check.

If the league scores `def_st_td`, `def_st_ff` or `def_st_fum_rec`, the forecast must supply `specialTeams`; an omitted block is refused rather than treated as an assumed zero. Where the league does not score them, the block may be omitted.

Use `floorDefense` with `floorStats`, `ceilingDefense` with `ceilingStats`, and `dynastyDefense` with `dynastyStats`. Every scenario uses identical validation and live scoring, so a ceiling may legitimately be a point mass — "they pitch a shutout" is a valid best case. A floor scoring above its mean, or a ceiling below it, is discarded and reported; the mean is unaffected. Byes and injury windows zero expected points after scoring while leaving the counts and probabilities visible, so a manager can still read why the unit ranked where it did.

## Expected scoring per component

Expected points are the sum of canonical raw amounts multiplied by the synchronized league's rates, rounded once by the shared scoring engine. The breakdown attributes that single total; it never re-scores anything. Group subtotals are exhaustive and sum back to the total:

| Group | Sleeper rules |
| --- | --- |
| Pressure | `sack` |
| Takeaways | `int`, `ff`, `fum_rec` |
| Defensive touchdowns | `def_td` |
| Safeties and blocked kicks | `safe`, `blk_kick` |
| Special teams | `def_st_td`, `def_st_ff`, `def_st_fum_rec` |
| Points and yards allowed | `pts_allow*`, `yds_allow*` |
| Other | Any further rule the league scores on a supplied stat |

The **drivers** list orders every non-zero component and both thresholds by absolute contribution, so the majority of a total is explained in one sentence: `Sacks +2.5, Interceptions +1.6, Defensive touchdowns +1.5`. The dashboard shows the per-category table with each Sleeper rule name, both tier tables with their probabilities and rates, and the sentence stating how much of a threshold bonus the probability actually bought.

## Streamer ranking

The existing legal add/drop, starter improvement, coverage and risk analysis remains in effect. Defense streamers additionally receive these disclosed heuristic ranking preferences. They are ranking units, never fantasy points, and are not calibrated probabilities. Let `clamp(x)` bound `x` to [-1,1]:

| Factor | Ranking preference |
| --- | --- |
| Shutout probability | `0.3 × P(shutout)` |
| Under 100 yards allowed | `0.2 × P(under 100 yards)` |
| Opponent pressure and sack exposure | `0.35 × clamp(((sackRateAllowed − 0.065)/0.035 + (pressureRateAllowed − 0.22)/0.10) / 2)` |
| Opponent interception and fumble rates | `0.3 × clamp(((interceptionRate − 0.024)/0.016 + (fumbleRate − 0.013)/0.009) / 2)` |
| Opponent offensive-line health | `0.3 × clamp(startersOut / 2.5)`, plus `0.1 × clamp((0.85 − continuity)/0.3)` when continuity is supplied |
| Opponent starting quarterback | `confirmed-starter` 0, `questionable` +0.1, `rookie-starter` +0.2, `backup` +0.3 |
| Opponent implied scoring | `0.25 × clamp((21 − impliedOpponentPoints) / 8)` |
| Expected game script | `−0.2 × clamp(spread / 14)`; positive team spread means underdog, and a favored defense faces more opponent dropbacks |
| Special-teams opportunity and opponent weakness | `0.3 × clamp(0.5 × clamp((returnOpportunities − 4)/3) + 0.5 × clamp((opponentReturnYardsAllowed − 9)/5 + muffRate/0.05))` |

Shutout and under-100 preferences are **deliberately separate from the probability-weighted bonuses already inside the points**. They express a preference for that upside shape — a unit whose ceiling comes from a threshold is a different bet from one whose ceiling comes from volume — and they are capped so the same probability can never dominate a ranking twice.

`context.includedInForecast: true` gives every *context* factor zero additional preference, because those inputs already informed the counts and tier probabilities; their descriptions stay visible. The two threshold preferences are derived from the forecast's own distributions and always apply. Preferences are rounded to two decimals before summing; the waiver engine rounds its final score to one decimal.

Context may be omitted when unavailable. Missing opponent pressure, takeaway rates, offensive-line health, starting-quarterback confirmation, licensed game environment or special-teams data are each disclosed as uncertainty and receive no favorable assumption. An `unknown` quarterback status is treated as missing, not as an advantage.

Optional `context.game` must contain `source` (nonempty provider name), `licensed: true`, `impliedOpponentPoints` and `spread` (team perspective, negative for favorites). This is the trusted adapter's licensing attestation, not automatic license verification. No betting endpoint or market feed is fetched by this feature. Without a licensed source, game script and implied scoring are omitted and disclosed. Source and timestamp provenance come from the enclosing forecast feed; adapters must refresh all supplied context with that feed.
