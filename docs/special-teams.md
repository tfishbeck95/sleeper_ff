# Individual special-teams forecast contract

Sleeper pays return production twice over, under two rule families that belong to two different fantasy entities:

- **`def_st_td`, `def_st_ff`, `def_st_fum_rec`** pay the **D/ST unit**. They are part of the [team defense contract](defense.md).
- **`st_td`, `st_ff`, `st_fum_rec`** pay a **rostered player** on their own stat line. That is this contract.

They are not aliases. In the captured live map `def_st_fum_rec` is 1 and `st_fum_rec` is 2, so collapsing them would double or halve a real event's value depending on which way the mistake ran. Both families are defined once, in `packages/domain/src/special-teams.ts`, and both the team contract and this one read their Sleeper keys from those maps.

This contract exists to make two things impossible: paying one return event to the wrong entity or to both, and quietly treating "the provider did not model it" as "it is worth zero".

## Field mapping

| Forecast field | Sleeper key | Scope |
| --- | --- | --- |
| `touchdowns` | `st_td` | Kick, punt, blocked-kick and fumble return touchdowns by this player |
| `forcedFumbles` | `st_ff` | Fumbles this player forces in the kicking game |
| `fumbleRecoveries` | `st_fum_rec` | Kicking-game fumbles this player recovers |
| `coverage.<category>` | — | Whether the provider models that category at all |
| `returnRole` | — | Depth-chart duty and expected returns; never scored |

`st_tkl_solo` is a fourth individual rule this contract does not model as a category. It remains an ordinary raw stat: supply it in `stats` and the league scores it, and the breakdown reports it as `otherPoints` so nothing is lost.

## Coverage is declared, not inferred

`coverage` is required, and every category is explicit:

```json
{
  "week": 8,
  "bye": false,
  "stats": { "rec": 5, "rec_yd": 62 },
  "specialTeams": {
    "forcedFumbles": 0.1,
    "fumbleRecoveries": 0.06,
    "coverage": { "touchdowns": false, "forcedFumbles": true, "fumbleRecoveries": true },
    "returnRole": { "kickReturns": "primary", "puntReturns": "committee", "expectedReturns": 3.5 }
  }
}
```

This example is illustrative, not a live forecast. A category declared modeled requires a nonnegative single-game expected count within its plausibility ceiling — 0.5 for `st_td`, 1 for `st_ff` and `st_fum_rec` — so a season total passed as a weekly line is refused rather than ranked. A category declared unmodeled must supply no count. The two statements must agree in both directions, because the difference between "we project 0.00 return touchdowns" and "we do not model return touchdowns" is the entire subject of this document, and a bare `0` cannot express it.

`returnRole` statuses are `primary`, `committee`, `situational`, `none` or `unknown`, per phase. `expectedReturns` is workload only; nothing here is ever converted to points. `expectedReturns` above zero contradicts a role with no duty in either phase and is refused.

Use `floorSpecialTeams` with `floorStats`, `ceilingSpecialTeams` with `ceilingStats`, and `dynastySpecialTeams` with `dynastyStats`. Each scenario carries its own coverage, so a ceiling may model a category the mean does not.

Overlapping counts inside `stats` are alternate descriptions of the same events, never quantities to add: a duplicate must agree within 0.000001 or the forecast is refused. A raw `st_*` key **requires** the declaring block, so a supplied count is never indistinguishable from a category nobody modeled. A rule this league does not define is dropped during normalization rather than pushed at the shared raw-stat unit check.

## What happens when a category is missing

The forecast is not refused — an incomplete return contract is normal, and refusing every player over it would leave a manager with no analysis at all. Instead:

1. **The league rule is read, never assumed.** The rate comes from the synchronized snapshot. A rule the snapshot does not define at all is reported as *undefined* — unknown in either direction — and is distinct from a rule configured at 0, which is reported as "scores it at 0, so modeling it would change nothing".
2. **Nothing is invented.** The unmodeled category contributes exactly 0 points and its expected count renders as `null` / "Not modeled", never as a zero a reader could mistake for a projection. No expected return-touchdown bonus is estimated from return volume, opponent weakness, or anything else.
3. **The projection is marked.** `coverage` becomes `partial` or `absent`, `uncovered` names the categories, and `coverageNote` condenses it to one sentence.
4. **The uncertainty is surfaced where it could decide something.** Start/sit cautions and waiver uncertainty name the gap when the forecast declares a **designated return role**, or when a forecast models some categories but not others. A league-wide absence of return modeling is disclosed once, as a lineup and waiver report warning, rather than appended to every projection.
5. **Return upside never promotes anyone.** `SpecialTeamsBreakdown.rankingAdjustment` is typed as the literal `0`. A return specialist is ranked on scoring this league's rules actually produced; a return touchdown nobody projected is never a reason to start or claim the lower-scoring player.

Point 5 has a mirror image the implementation also avoids. The coverage note is added to a waiver candidate's uncertainty list *after* its risk grade is computed, so an incomplete feed does not demote the return specialists it concerns. A provider-wide contract gap is a property of the feed, not of one candidate, and it moves the ranking in neither direction.

## Entity identity

The scoring boundary refuses, as an `identity` rejection rather than a units one, every crossing of the two families:

| Situation | Refused because |
| --- | --- |
| A `DEF` entity carries `specialTeams` | The unit's return events belong in `defense.specialTeams` |
| A rostered player carries `defense` | Team special-teams events belong to the D/ST entity |
| A `DEF` stat line supplies `st_td`, `st_ff`, `st_fum_rec` or `st_tkl_solo` | Those pay a rostered returner, at different rates |
| A player's stat line supplies `def_st_td`, `def_st_ff`, `def_st_fum_rec` or `def_st_tkl_solo` | Those pay the unit, at different rates |

Within one entity, the declaring block and any overlapping raw key are reconciled to a single canonical count before scoring, so the same return touchdown is scored exactly once. Because the families are mutually exclusive per entity and reconciled within it, one real event can be paid to the unit, to the returner, or to both — which is what Sleeper does — but never twice to the same fantasy entity.

## Scoring attribution

Points are the sum of canonical raw amounts multiplied by the synchronized league's rates, produced once by the shared scoring engine. The breakdown attributes that single total and never re-scores anything:

| Field | Meaning |
| --- | --- |
| `components[]` | One row per category: the individual rule, its team counterpart, the expected count or `null`, this league's rate or `null`, and the points |
| `expectedPoints` | The modeled categories only |
| `otherPoints` | Any further individual `st_*` rule on the same stat line |
| `coverage` | `complete`, `partial`, `absent` or `not-scored` |
| `uncovered` / `undefinedRules` | Categories this league scores but the forecast omits / categories the snapshot does not define |
| `relevance` | `designated`, `unknown` or `not-relevant`, from `returnRole` |
| `rankingAdjustment` | Always `0` |

Byes and injury windows zero the points after scoring while leaving coverage, counts and role visible, so a manager can still read why a player ranked where they did.
