# Kicker forecast contract and streaming

Kicker forecasts use the same validated complete live Sleeper scoring snapshot as other positions. No reference scoring, team reputation or consensus rank enables a projection. The synchronized player directory identifies kickers; every K weekly mean, supplied floor/ceiling and dynasty typical week must have the detailed contract below. Missing or inconsistent detail refuses that player's forecast and excludes it from ranking instead of substituting zero.

## Sleeper miss semantics

Verified against [Sleeper's scoring options](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available) on 2026-09-09: the unqualified **FG Missed** category is separate from distance-specific misses, and blocked field goals and PATs count as misses. Accordingly, `fgmiss` represents **all field-goal misses**, including blocks. It is not the misses in an unspecified distance bucket. The local synchronized scoring fixture maps this category to `fgmiss`; its rate is -1 and its distance-specific miss rates are zero. The support article predates the current six-band split; the synchronized league map is authoritative for the enabled distance keys and their rates.

The adapter declares `all-attempts-including-blocks` semantics. If a source excludes blocks, convert its attempted/made/missed counts using authoritative block data before producing this contract; never assume the missing count is zero. All counts refer to official attempts (excluding nullified plays).

The boundary derives each band's misses as attempts minus makes, then sums the six **disjoint** bands once for `fgmiss`. A supplied total, distance misses, or duplicate Sleeper stats must agree within 0.000001. An aggregate and its subsets are alternate descriptions, never quantities to add together. `fgmiss_50p` is the sum of 50–59 and 60+ misses. If the league explicitly enables both aggregate and distance miss rules, their distinct configured rates each apply once; provider duplication does not create extra deductions. Made-kick aggregate/50+ keys follow the same normalization.

## Adapter example

Within an existing weekly forecast, `stats` can be empty when all scoring counts come from `kicker`:

```json
{
  "week": 8,
  "bye": false,
  "opponent": "OPP",
  "stats": {},
  "kicker": {
    "fieldGoals": {
      "0_19": { "attempts": 0.1, "makes": 0.1 },
      "20_29": { "attempts": 0.4, "makes": 0.38 },
      "30_39": { "attempts": 0.7, "makes": 0.63 },
      "40_49": { "attempts": 0.8, "makes": 0.68 },
      "50_59": { "attempts": 0.6, "makes": 0.45 },
      "60p": { "attempts": 0.1, "makes": 0.04 }
    },
    "pat": { "makes": 2.4, "misses": 0.1 },
    "misses": { "semantics": "all-attempts-including-blocks", "total": 0.42 },
    "longAttemptProbability": 0.5,
    "context": {
      "includedInForecast": true,
      "offense": { "drivesPerGame": 10.5, "scoringDriveRate": 0.42 },
      "opponent": { "redZoneTouchdownRate": 0.55 },
      "stadium": { "name": "Example stadium", "roof": "outdoor" },
      "weather": { "windMph": 12, "precipitationProbability": 0.2, "temperatureF": 55 }
    }
  }
}
```

This example is illustrative, not a live forecast. `misses.byDistance`, when present, must contain all six bands; total and byDistance may both be supplied. Explicit zero counts are required for unused bands. Attempts and makes are nonnegative expectations, makes cannot exceed attempts, and probabilities are fractions in [0,1]. `longAttemptProbability` is P(at least one attempt from 50+), supplied from the provider's distribution; it is not long attempts divided by all attempts. It cannot exceed expected long attempts, and must be positive if expected long attempts are positive.

Use `floorKicker` with `floorStats`, `ceilingKicker` with `ceilingStats`, and `dynastyKicker` with `dynastyStats`. Every supplied scenario uses the identical validation and live scoring. An optional floor scoring above its mean, or ceiling below it, is discarded. Without scenarios, no point floor is invented. Byes and injury windows zero points and miss exposure after scoring. Generic role and nonneutral matchup multipliers are refused for kickers; contextual forecasts belong in attempts/makes.

For an active made-kick yardage rule (`fgm_yds`, `fgm_yds_over_30`), the adapter must additionally supply that projected yardage in `stats`; category midpoints are never substituted. Other custom stats still pass the shared unit/pre-scored checks. Unknown kicker detail fields, including embedded points or consensus rank, are rejected.

## Streamer ranking and display

Expected points are the sum of canonical raw stats multiplied by the synchronized league's rates, rounded by the shared scoring engine. **Miss downside** is the positive magnitude of negative field-goal/PAT miss contributions already included in that total. It describes expected deductions, not a worst-case floor or the additional opportunity cost of a miss instead of a make. The UI shows both points and downside, all distance attempts/makes/misses, accuracy and long-attempt probability. The copyable streamer plan preserves the points/downside explanation.

The existing legal add/drop, starter improvement, coverage and risk analysis remains in effect. Kicker streamers additionally receive these disclosed heuristic ranking preferences. They are ranking units, never fantasy points, and are not calibrated probabilities. Let `clamp(x)` bound x to [-1,1]:

| Factor | Ranking preference |
| --- | --- |
| Expected attempts | `0.3 × clamp((attempts − 2) / 2)` |
| Long-distance opportunity | `0.3 × P(at least one 50+ attempt)` |
| Accuracy | `0.2 × clamp((makes/attempts − 0.8) / 0.2)`; zero preference when no attempts |
| Miss downside | `−min(2, 0.5 × expected miss deductions)`; additional conservative preference explicitly separate from the already deducted points |
| Offensive drive quality | `0.3 × clamp((drivesPerGame × scoringDriveRate − 4) / 4)` |
| Opponent red zone | `0.25 × clamp((0.6 − redZoneTouchdownRate) / 0.4)` |
| Stadium/weather | Indoors/closed roof: no weather penalty. Exposed field: `−0.4 × clamp((max(0, windMph−10)/20 + precipitationProbability + max(0,32−temperatureF)/32)/3, 0, 1)` |
| Licensed implied scoring | `0.2 × clamp((impliedTeamPoints − 24) / 12)` |
| Licensed game script | `−0.15 × clamp(spread / 14)`; positive team spread means underdog |

`context.includedInForecast: true` gives every context factor zero additional preference because those inputs already informed the raw counts; their descriptions remain visible. Workload, accuracy and conservative miss preferences remain explicitly separate ranking criteria. Preferences are rounded to two decimals before summing; the existing waiver engine rounds its final score to one decimal.

Context may be omitted when unavailable. Missing drives, opponent red-zone data, stadium/weather or licensed game environment are disclosed as uncertainty and receive no favorable context assumption. Missing roof information prevents application of outdoor weather. A closed roof needs no outdoor weather forecast.

Optional `context.game` must contain `source` (nonempty provider name), `licensed: true`, `impliedTeamPoints` and `spread` (team perspective, negative for favorites). This is the trusted adapter's licensing attestation, not automatic license verification. No betting endpoint or market feed is fetched by this feature. Without a licensed source, game script and implied scoring are omitted and disclosed. Source/timestamp provenance comes from the enclosing forecast feed; adapters must refresh all supplied context with that feed.
