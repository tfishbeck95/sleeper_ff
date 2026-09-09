# Trade engine

`GET /api/trades/:leagueId?userId=<Sleeper owner or co-owner ID>&week=8`

The route uses the app’s existing bearer token and synchronizes the league before reading one roster/player/pick context. A Sleeper user ID selects a roster; it is not an identity credential. There is no trade submission or messaging endpoint. Connected leagues never fall back to sample projections. `/api/trades/demo?format=redraft` and `format=dynasty` use a partial fictional scoring reference and return unavailable rankings.

## Forecast configuration

Trades reuse `WAIVER_SIGNALS_PATH` and the injectable `WaiverSignalProvider`. See [waivers.md](waivers.md) for the complete raw-stat source schema. No new service subscription is automatically provisioned. The API process must receive this environment variable explicitly.

Every rostered player, including reserve/taxi players, needs player metadata and raw stats with explicit `bye` flags for every remaining fantasy week. Raw statistics are converted to points by the shared scoring boundary described in [lineup.md](lineup.md), using the selected league's own rules; a provider's fantasy-point total is never accepted. A projection whose units or player identity fail validation is refused and named in the report's `rejected` list, and because trade valuation needs every rostered player, one refusal makes the whole analysis unavailable rather than valuing that player at zero. Each player asset exposes `scoring` — the snapshot ID, the label, the selected week's league-scored points, the explanation sentence and the ordered contributions. Picks have no stat line, so their `scoring` is `null`.

Each player asset also exposes `opportunity` (see [lineup.md](lineup.md)), and where receptions
actually drive the value, the asset's explanation quantifies the premium: how many of its points come
from receptions, what the same stat line would project under non-PPR scoring, and — for a back
running a receiver's route load — that standard-scoring running-back rankings do not price it. A pure
rusher's explanation says nothing about receptions. This is disclosure of scoring already applied, not
an additional valuation term: no model unit anywhere is increased for being a reception twice. Optional role and matchup adjustments apply once. Missing forecasts, malformed values, stale forecasts (48 hours), and stale rosters (10 minutes) return unavailable analysis. An unavailable player with no supplied return week remains unavailable throughout the forecast window. This intentionally conservative treatment differs from waiver streaming.

Dynasty players additionally require these validated source fields:

```json
{
  "playerId": "actual-sleeper-player-id",
  "age": 25,
  "expectedCareerYears": 5,
  "uncertainty": 0.35,
  "tradeEligible": true,
  "dynastyStats": {"rec": 5, "rec_yd": 65, "rec_td": 0.4},
  "weeks": [{"week": 8, "bye": false, "stats": {"rec": 5, "rec_yd": 65}}]
}
```

Expand `weeks` through the configured championship, or week 18 if no playoff schedule is configured. `expectedCareerYears` is the source’s expected remaining fantasy-relevant career, not a fixed retirement-age assumption. `uncertainty` is a 0–1 index, not a calibrated probability; it defaults to 0.35. Injury designations impose additional uncertainty floors. `tradeEligible: false` and league `protectedTradeIds` exclude assets from offers.

Optional league policy inside the signal file:

```json
{
  "leagues": {
    "actual-league-id": {
      "rookieDrafts": [{"season": "2027", "rounds": 3}],
      "tradeStrategies": {"1": "contender", "2": "rebuilder"},
      "protectedTradeIds": [],
      "positionLimits": {"QB": 4}
    }
  }
}
```

`rookieDrafts` is a trusted, complete definition of upcoming rookie drafts within the next five seasons. For each draft, native picks are generated for every original roster and round; synchronized traded-pick ownership overrides the native owner exactly once. Missing draft definitions or fresh transfer coverage makes capital unknown and excludes pick offers. An empty, successfully synchronized transfer list means no transferred picks; it does not mean no native picks. Sync replaces the league’s transfer snapshot, including removals and reordered results, using stable season/round/original-roster IDs. Pick transfers refresh every five minutes; the trade context requires them within ten minutes. Current-season startup/rookie picks are excluded because completed draft state is not reconstructed.

## Valuation and needs

Values are explainable model units, not externally calibrated market prices.

- **Redraft:** mean league-scored points across remaining weeks, with byes and known absences included. Age and rookie picks contribute no premium.
- **Dynasty:** blend remaining-season mean with expected future typical-week points. Future points are multiplied by a discounted career horizon (18% annual discount, fractional years, five-year cap) divided by three and an age factor `clamp(1 + (27 - age) × .02, .5, 1.15)`. Current-season weights are 65% for contenders, 40% for balanced teams and 20% for rebuilders. These are explicit heuristics, not empirical NFL age curves.
- **Rookie picks:** neutral units `18 / round^1.35 × .85^(yearsAway - 1)`. This assumes a middle draft slot. Contenders weight capital at 85%, rebuilders at 115%, balanced teams at 100%. Future finish, class strength and development are unknown; picks carry at least 0.55 risk.

Neutral package values support a common fairness comparison. The delivered/received values displayed for each team use that team’s strategy and may therefore differ from the other side’s figures. The asset detail disclosure shows the neutral units and valuation inputs.

Every team receives an evaluation, including position needs, removable surplus, projected lineup, contention rationale and dynasty capital where known. Default contention blends projected lineup percentile (70%, ties share a percentile) and win rate (30%, neutral until games exist). Values ≥0.6 indicate a contender; dynasty values ≤0.35 indicate a rebuilder. Others are balanced. Trusted policy can override this heuristic. It is not playoff probability or a claim about the manager’s intentions.

Starter needs compare points attributed to eligible positions in optimal lineups with league averages. Depth compares the best two nonstarters’ remaining-season projections at each position. Rebuilders also compare the best two players’ future-oriented value per position and owned pick capital with league averages; a roster with an average career horizon under three years has an explicit capital replenishment target at least five units above its holdings. Reserve/taxi players are valued as roster assets but are not assumed promotable, used as active depth, or offered in trades.

## Candidate gates and search

1. Search owned, unprotected active players and verified picks. Shortlist the highest-valued assets per team. Generate one-for-one and two-for-one offers; a two-asset package must contain a pick or surplus player removable without hurting the current optimal lineup. This bounded search is not exhaustive, and truncation is disclosed.
2. Both managers must receive an asset addressing an already identified need with a measurable gain. Equal values alone are insufficient.
3. Recompute exact optimal lineups with a rectangular Hungarian assignment, including flex, superflex and multiple eligible positions. Do not reuse current submitted starters or greedily fill slots.
4. Both post-trade rosters must fit active capacity and supplied position caps, and fill every starter slot through **every remaining fantasy week**, including known byes/injuries. Reserve/taxi constraints must already be valid. No speculative waiver adds, reserve promotions, roster drops or lineup moves are assumed.
5. Redraft, contender and balanced teams cannot lose selected-week projected lineup points. Dynasty rebuilders may sacrifice only the configured fraction for an identified rebuilding need. Both managers’ strategy-adjusted incoming value must remain within the configured loss bound, and neutral package imbalance must pass fairness independently.
6. The maximum asset uncertainty or proportional lineup sacrifice is the offer risk index; it must be within bounds. No averaging away a risky asset with a safer one.

Rank qualifying offers by the user’s summed need gains plus selected-week lineup gain, then lower risk, lower imbalance and stable asset IDs. This ranks roster-fit alternatives; it does not estimate acceptance. Every offer stands alone against the current roster.

Fallbacks come from the same fully evaluated pool, for the same manager and at least one of the same user weaknesses. Their total strategy-adjusted delivered value is strictly lower. The target may differ. If none exists, the UI explicitly says so rather than presenting an unfair lowball offer.

## Configurable bounds

Each bound is a query parameter, or a `bounds` property for `recommendTrades` callers. Unknown, nonfinite and out-of-range fields return HTTP 400 before sync.

| Parameter | Default | Valid range |
| --- | --- | --- |
| `maxValueGap` | 0.25 | 0–1; absolute neutral difference / larger package, also bounds each team’s contextual value loss |
| `maxRisk` | 0.65 | 0–1 uncertainty index |
| `minNeedGain` | 0.5 | 0.01–50 model units |
| `maxRebuilderLineupLoss` | 0.10 | 0–1, dynasty rebuilders only |
| `maxResults` | 8 | integer 1–30 |
| `maxAssetsPerTeam` | 18 | integer 1–30 |

The web panel exposes value-gap and risk controls, full evaluations, both lineups before/after, delivered/received values, risks, partner rationale and fallbacks. The message editor supports friendly/direct regeneration and copying the exact edited text. Regeneration replaces edits; copying never sends a message. League/parameter changes clear obsolete results and messages.

Keeper cost rules are not implemented; keeper leagues return unavailable rather than reuse unsuitable values. Custom commissioner restrictions not represented by league settings or trusted policy still require manual review. These endpoints use current roster snapshots, not historical reconstruction.

## Verification

`npm test`, `npm run typecheck`, and `npm run build` cover the API, shared contracts and web. Trade tests include exact assignment versus brute force, flex/negative projections, bilateral need gates, future bye coverage, dynasty age/horizon/strategy changes, native and transferred picks, stale/incomplete data, risk/fairness/capacity constraints, authenticated roster selection, validated fallbacks, message generation and rendered loading/error/report states.
