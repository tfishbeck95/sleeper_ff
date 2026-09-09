# Quarterback forecasts and scoring

Quarterbacks use the same raw-stat scoring boundary as every other player. Passing touchdowns (`pass_td`), passing yards (`pass_yd`), interceptions (`pass_int`), rushing yards (`rush_yd`), and rushing touchdowns (`rush_td`) are itemized with their raw amounts, exact synchronized league rates, and resulting points. Other league rules (including conversions, bonuses and fumbles) remain in the total. Missing statistics are labeled “Not supplied”; an explicit zero is shown as zero.

These totals drive start/sit choices, replacement-level calculations, waiver streamer rankings and trade values. Rushing points and turnover deductions are disclosed alongside those decisions. Head-to-head explanations flag when the rushing differential is what puts the recommended starter or streamer ahead. There is no categorical rushing-quarterback bonus or receiving-opportunity floor lift for quarterbacks.

Providers may attach optional rushing subsets to each weekly raw-stat scenario:

```json
{
  "week": 8,
  "bye": false,
  "stats": { "pass_yd": 200, "pass_td": 1, "pass_int": 1, "rush_yd": 70, "rush_td": 1 },
  "rushingSplit": {
    "designedRuns": { "yards": 40, "touchdowns": 1 },
    "scrambles": { "yards": 30, "touchdowns": 0 }
  },
  "floorStats": { "pass_yd": 140, "pass_td": 0, "pass_int": 2, "rush_yd": 20, "rush_td": 0 },
  "ceilingStats": { "pass_yd": 300, "pass_td": 3, "pass_int": 0, "rush_yd": 100, "rush_td": 2 }
}
```

`dynastyRushingSplit` may accompany a player’s `dynastyStats`. `floorRushingSplit` and `ceilingRushingSplit` use the same structure for their corresponding scenarios. Subsets may contain yards, touchdowns, or both. Their nonnegative totals must not exceed the corresponding aggregate rushing statistic; partial coverage is allowed. Pre-scored points, unknown fields, nonfinite amounts, and subsets without a corresponding aggregate are rejected. Subsets use the same rushing rates and are displayed as contributions already included in the total; they are never added again. Aggregate rushing cannot establish whether a run was designed or a scramble, so absent splits remain unknown.

Floor and ceiling come only from separately supplied raw-stat scenarios, scored using the same rules as the mean. Inverted scenarios are discarded and reported. Missing scenarios remain unknown and are never estimated from a QB archetype. Existing matchup, role, bye and availability adjustments apply consistently to the total and each component, with the multiplier disclosed separately from the raw amounts and league rates.

The API carries quarterback attribution on `ScoredPoints.quarterback`, weekly scenario breakdowns on lineup views and waiver recommendations, and remaining-week breakdowns plus future typical-week attribution on trade assets. Trade model units continue to derive from the league-scored remaining-week and dynasty totals; run subsets do not change those units. Rest-of-season waiver disclosures identify the selected week's components separately from the weighted remaining-week headline.
