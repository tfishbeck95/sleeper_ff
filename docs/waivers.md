# Waiver recommendations

The API ranks independent add/drop alternatives for an owner or co-owner in the selected league. The web dashboard renders the result, intersects position/horizon/risk/need filters, allows excluding pairs, and copies a priority-ordered claim plan.

## API and data source

`GET /api/waivers/:leagueId?week=8&force=false` uses application session authentication. Invalid weeks return 400; accounts without a roster return 403. The server selects the roster from the Sleeper identity linked to the authenticated application user; callers cannot select another user with a query parameter.

The endpoint synchronizes the selected league using the existing cache intervals, then reads one consistent stored league/roster/player context. `force=true` refreshes upstream data. A failed Sleeper sync fails the request rather than serving seemingly current availability. Injury designations are now preserved by the player normalizer. The player directory normally refreshes daily; Recheck forces a refresh, so use it judiciously.

[Sleeper's supported API](https://docs.sleeper.com/) is read-only. It supplies league scoring, roster positions, roster ownership and player metadata, but the documented endpoints do not supply the baseline stat forecasts, opponent strength estimates, role histories or dynasty forecasts used here. There is no claim submission endpoint in this implementation.

Set `WAIVER_SIGNALS_PATH` in the **API process environment** to a JSON file populated by a trusted forecast job, or inject a `WaiverSignalProvider` as the fourth `createApp` argument. The server does not automatically load `.env` files. The file is read for each analysis, so an external job can replace it atomically without restarting the server. Use actual Sleeper player IDs. Supply forecasts for rostered players as well as acquisition candidates: otherwise their drop and starter comparisons cannot be evaluated.

The validated schema is `WaiverSignals` in `apps/api/src/waiver-signals.ts`. This abbreviated example shows one player; expand `weeks` to include **every remaining week through the configured league championship** for season value and safe drop selection:

```json
{
  "season": "2026",
  "week": 8,
  "source": "Your licensed forecast feed",
  "updatedAt": "2026-10-27T12:00:00Z",
  "players": [{
    "playerId": "actual-sleeper-player-id",
    "weeks": [{
      "week": 8,
      "stats": {"rec": 5, "rec_yd": 65, "rec_td": 0.4},
      "floorStats": {"rec": 3, "rec_yd": 34, "rec_td": 0.1},
      "ceilingStats": {"rec": 8, "rec_yd": 108, "rec_td": 0.9},
      "opponent": "BUF",
      "bye": false,
      "matchupMultiplier": 1.05,
      "opportunity": {
        "targets": 8,
        "routes": 32,
        "targetsPerRouteRun": 0.25,
        "routeParticipation": 0.88,
        "targetShare": 0.24,
        "redZoneTargets": 1.5
      }
    }],
    "recentTargets": [9, 8, 10, 9, 9, 8],
    "dynastyStats": {"rec": 6, "rec_yd": 75, "rec_td": 0.5},
    "injuryStatus": "Questionable",
    "role": {"recentShare": 0.65, "previousShare": 0.45, "games": 3},
    "acquisitionEligible": true,
    "droppable": true
  }],
  "leagues": {
    "actual-league-id": {
      "blockedAddIds": [],
      "protectedDropIds": [],
      "positionLimits": {"QB": 3},
      "faabRemaining": {"1": 42}
    }
  }
}
```

Forecasts are raw baseline stats; a provider never supplies fantasy points. Every stat line, including the optional `floorStats` and `ceilingStats` scenarios, is scored by the selected league's own rules exactly once in the shared boundary described in [lineup.md](lineup.md). A projection whose statistic is not defined by this league's scoring rules, whose player ID matches no synchronized Sleeper player, or which supplies a pre-scored key such as `points` or `projectedPoints`, is refused: it appears in the report's `rejected` list with the reason and is excluded from ranking, never counted as zero. A floor that scores above its mean, or a ceiling below it, discards only that scenario and keeps the validated mean. Apply each Sleeper scoring key, including any custom bonus keys supplied by the provider, exactly once.

Generic role and matchup point multipliers are prohibited. A heuristic trend uses `forecastAdjustments` and names one measurable input: target share, route participation, carry share, goal-line usage, snap rate, quarterback change, or an injury-related workload change. Each record has a stable `trendId`, evidence, additive `statChanges` in raw-stat units, and a positive `maxAbsoluteStatChange`; every delta must fit that bound and the result cannot make a stat negative. The adjustment is applied before league scoring. `baselineIncorporates: true` requires empty changes and records that the baseline already contains the signal, preventing it from being applied twice. Duplicate IDs within a week are rejected. Legacy `role` observations are disclosure-only and never add projected or ranking points; non-neutral `matchupMultiplier` values are rejected at the scoring boundary.

### Receiving opportunity

`opportunity` is workload, not scoring. `targets` is not a Sleeper scoring key, so it would be refused inside `stats`; projected receptions belong in `stats.rec`, where the league scores them exactly once. Supply `targetsPerRouteRun` directly or leave it to be derived from `targets / routes`; supply `routeParticipation` and `targetShare` (the receiving share) especially for running backs, and `redZoneTargets` where you have them. Rates are fractions from 0 to 1, targets cannot exceed routes, and red-zone targets cannot exceed targets.

`recentTargets` is the **observed** target count in each of the most recent games, oldest first. Weekly target stability is `1 - coefficient of variation` over that series, clamped to 0-1, and the recent target trend is the most recent third's average minus the earlier games'. Fewer than three observed games yields no stability, and fewer than four yields no trend, rather than a flattering default. Do not supply projections here; smoothed projections would report perfect stability for everyone.

These fields never become points. They are used to:

1. **Lift the modeled floor** for consistently targeted players: a *supplied* floor scenario is moved toward its own mean by `(stability - 0.5) / 0.5 x 0.25`, capped at 25% of the floor-to-mean gap, and only when receptions are at least 25% of the league-scored total. The mean and the ceiling never move, a missing floor is never invented, and the lift appears in the week's `adjustments`.
2. **Identify pass-catching running backs** — a back at 50% route participation, a 12% target share, or 3.5 targets per week — and state what standard-scoring rankings leave out: `receptionExplanation` gives the reception points, their share, and what the same stat line projects under non-PPR scoring.
3. **Distinguish volume-driven from touchdown-dependent receivers** by where the already-scored points came from. Touchdown dependence (40% or more of the total) is reported as uncertainty, which feeds the existing risk grade; it is never a hidden points penalty.
4. **Prefer stable reception volume** for lineup decisions and season-long adds.
5. **Prefer target growth** for streamers and waiver breakouts.
6. **Explain a trade target's full-PPR premium** in points on the asset itself.

Preferences 4 and 5 are disclosure and tie-break context only. They never add synthetic points to the waiver ranking. Any expected production effect must be represented by a bounded raw-stat adjustment before league scoring, and each row states whether that adjustment was applied or already present in the baseline.

`floorStats` and `ceilingStats` are optional low/high raw stat lines for the same week. They are the only source of a floor or ceiling: no range is ever estimated from the mean, and lineup analysis withholds a spread and a win probability when they are absent.

`dynastyStats` describes a projected future typical week in the same scoring units. Dynasty value is never invented from age alone. `unavailableThroughWeek` can explicitly zero projections during a known recovery/suspension window; otherwise an unavailable injury designation zeros the selected week and leaves later forecasts uncertain. A missing opponent or strength adjustment remains unknown/neutral and appears in the uncertainty explanation. `bye: true` zeros that week's forecast.

Constraints and FAAB overrides are scoped to a league. `faabRemaining` keys are roster IDs and can include budget trades/commissioner adjustments. Without an override, FAAB uses configured budget minus the roster's reported budget used; the report identifies that limitation. `waiver_type=2` activates dollar advice. Priority leagues receive no invented dollar bids. Missing balances receive no range.

Wrong season/week, absent feeds, feeds over 48 hours old, timestamps over five minutes in the future, and malformed files produce an explicit unavailable result. Duplicate player IDs/weeks, nonfinite stats, out-of-range role/matchup inputs and invalid limits fail validation. Missing players are excluded from forecasts; they are never assigned zero value. The API does not automatically procure an external data subscription.

`GET /api/waivers/demo` uses a partial fictional scoring reference and returns unavailable rankings with no live Sleeper link. It never substitutes for connected-league analysis.

## Ranking and roster rules

1. Union every league roster's players, starters, reserve and taxi IDs to exclude owned players. Incomplete league roster counts block analysis. Restrict candidates to league-eligible positions (including flex/superflex/IDP rules), supplied acquisition constraints and league activity settings. Retired/deceased players are excluded.
2. Apply league scoring, explicit opponent/role adjustments, byes and injury windows to raw stat forecasts.
3. Compare each horizon with the weakest **eligible current starter**, preserving null for unknown starter baselines, and with the weakest fully valued droppable bench option. Empty starter slots have a zero baseline.
4. Choose the lowest-retention legal bench drop. Retention is the maximum of current-week and remaining-season value, plus future typical-week value in dynasty leagues. Require complete retention evidence, respect positional caps after the pair, preserve the number of fillable starting slots across remaining bye/injury schedules with flex-aware matching, and protect current starters, reserve, taxi and explicit no-drop players. An open active slot needs no drop. An overfull roster requires correction first.
5. Streamers need a positive current starter improvement and a positive gain after drop retention cost. Season additions need positive remaining value after that cost; season value blends the remaining weekly average (75%) with the remaining playoff average (25%). The playoff window uses league start week, rounds and championship length, capped at NFL week 18; verify unusual commissioner schedules. Dynasty stashes require explicit dynasty stats and a dynasty league.
6. Rank by net value plus 60% of positive starter gain, plus two points for bye/injury cover, less a risk penalty (0, 0.75 or 2). Nonpositive scores are omitted. Stable ties use player ID and horizon. Each row includes the underlying gains, source information, drop rationale, opponent/bye outlook, playoff impact and uncertainty. These are heuristics, not probabilities or market-clearing bids.
7. Every row states the league scoring that produced its number (`pointsExplanation`, e.g. `18.4 points under your league's full-PPR scoring this week`) and carries the ordered scoring `contributions`, which the dashboard discloses on demand. The report carries `scoringSnapshotId`, `scoringLabel`, `forecastUpdatedAt` and the `rejected` list.

All comparisons use the current roster and current injury metadata, even when a different forecast week is selected. This endpoint is not a historical roster reconstruction. No projections means no ranked live claims; configuring the signal source is required for live recommendations.

FAAB ranges scale a heuristic share of the original budget (or explicitly the remaining balance if the original is unavailable) by value, urgency and risk, then cap both endpoints at the remaining balance. High risk lowers the floor and widens uncertainty. A zero balance produces $0–$0 with a reminder to check whether $0 bids are allowed. Competitor bids, claims, acquisition locks and processing times are not assumed to be known.

## Copyable plan

Only selected pairs matching the current filters enter the plan. A player appears once even if multiple horizons are selected. Repeated drops are conditional fallback claims; open-slot additions conservatively share one slot. At most one addition per drop/slot group may succeed. For independent groups the plan reserves the largest alternative bid, caps later ranges to remaining budget, and omits a claim when its minimum is unaffordable. Each pair is evaluated independently; the plan tells the user to recheck combined positional limits and starter coverage if multiple groups may succeed. The preview contains the exact copied text and provides a fallback if clipboard access fails.

The plan is still advice. The user must refresh availability and review the exact add/drop, bid, locks, claim order and deadline, then **submit claims in Sleeper**. Neither copying the plan nor following the league link submits a claim.

## Verification

`npm test`, `npm run typecheck`, and `npm run build` cover both workspaces. Waiver tests exercise league ownership, IR/taxi exclusion, flex/custom scoring, injuries/byes, opponent/role/playoff adjustments, missing/stale sources, protected dynasty drops, position caps, FAAB limits, endpoint membership and errors, intersecting filters, duplicate/fallback claims and cumulative plan budgets.

## Kicker streamers

See [kicker forecasts and streaming](kickers.md) for the required distance/PAT contract, aggregate versus category miss reconciliation, live scoring, expected miss downside and disclosed workload/context ranking preferences.

## Team defense streamers

See [team defense forecasts and streaming](defense.md) for the required raw categories, the points-allowed and yards-allowed tier distributions, the separation of forced fumbles from fumble recoveries and of team from individual special-teams rules, expected scoring per component, and the disclosed opponent pressure, takeaway, offensive-line, quarterback, game-script, threshold and special-teams ranking preferences.
