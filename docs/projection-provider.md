# Projection and injury provider adapter

Sleeper's documented API supplies league scoring, rosters and player metadata, but no forward
projections and no injury report. This adapter fetches those from licensed sources, maps them onto
Sleeper player ids, validates the result against the same schema the file adapter uses, and stores it
atomically. It never produces fantasy points: the league's own rules do that later, at the single
boundary in [`apps/api/src/projection-scoring.ts`](../apps/api/src/projection-scoring.ts).

The adapter is **opt-in**. Without `PROJECTION_FEED_ENABLED=true` nothing starts, no credential is
read, and the existing `WAIVER_SIGNALS_PATH` file adapter continues to work unchanged.

## Sources and licensing

| Role | Source | Licence | Redistribution |
| --- | --- | --- | --- |
| Weekly projections, team defense projections, injuries | **SportsDataIO NFL** | Commercial data licence, per subscription ([terms](https://sportsdata.io/terms)) | **Prohibited** |
| Sleeper player id map, bye weeks, official injury reports, empirical distributions | **nflverse** and **DynastyProcess** | CC BY 4.0 | Permitted with attribution |

**Why these.** SportsDataIO's terms are published, priced, and explicitly permit use inside an
application. The alternatives with comparable coverage do not: ESPN's and Yahoo's fantasy endpoints
are undocumented and their terms forbid this use, and Sleeper's own projections endpoint is
undocumented, which [`docs/product-scope.md`](product-scope.md) already places out of scope. nflverse
is separate on purpose — it is the only openly licensed cross-reference carrying Sleeper's own player
ids, and the identity map must keep working if the paid subscription lapses.

**Obligations this code honours.**

- *No redistribution of SportsDataIO records.* Ingested provider rows never reach a response body.
  The API serves league-scored points and the explanations behind them, which are this application's
  own output — the same boundary [`docs/product-scope.md`](product-scope.md) already draws around
  Sleeper's data. `SourceLicense.redistributable` records the constraint next to the data it governs.
- *Attribution for nflverse and DynastyProcess.* Carried on every feed in
  `FeedProvenance.licenses[].attribution`; surface it wherever derived output is published.
- No undocumented endpoints, no scraping, no credential collection.

**Before you deploy, confirm your own subscription tier covers your intended use.** The table records
what the adapter assumes; only your agreement is authoritative.

## Credentials

| Variable | Purpose |
| --- | --- |
| `SPORTSDATAIO_API_KEY` | SportsDataIO subscription key. Required when the adapter is enabled. |

The key travels as an `Ocp-Apim-Subscription-Key` **header**, never in a query string, because query
strings reach proxy logs and error reports intact. It is never included in a thrown error's message.
A missing key fails the process at startup rather than yielding an empty fetch, which would be
indistinguishable at the storage layer from a week in which nobody was projected.

nflverse needs no credential. To rotate the SportsDataIO key, set the new value and restart; the
adapter reads it once at construction.

## Configuration

```bash
PROJECTION_FEED_ENABLED=true
SPORTSDATAIO_API_KEY=your-subscription-key
PROJECTION_FEED_PATH=../../data/projection-feed.json
PROJECTION_FEED_STALE_HOURS=12            # retained feed is marked stale past this age
PROJECTION_FEED_MAX_SOURCE_AGE_HOURS=6    # the source's own timestamp, not ours
PROJECTION_FEED_MIN_IDENTITY_MATCH=0.95
PROJECTION_FEED_MIN_PLAYERS=300
PROJECTION_FEED_REQUIRE_COMPLETE_COVERAGE=false
PROJECTION_FEED_ALERT_WEBHOOK=            # optional; console alerting is always on
PROJECTION_FEED_TIME_ZONE=America/New_York
NFL_SEASON=                               # defaults to the current season
NFL_WEEK_ONE_TUESDAY=                     # override the computed Labor Day anchor
```

## What the adapter produces

A `WaiverSignals` document — the schema already documented in [waivers.md](waivers.md) — plus a
`FeedProvenance` envelope and an `IngestionReport`, stored together so a feed can never disagree with
the run that produced it. Provenance carries the source name, the **source's own** timestamp, our
ingestion timestamp, the season, the week, every contributing licence, and each contributor's
timestamp separately.

Conflating the source timestamp with the ingestion timestamp is how a stale feed passes for a fresh
one: a source that stops updating keeps answering 200 with an old timestamp, and only the gap between
the two reveals it.

### Identity mapping

Resolution is strongest-first and never guesses:

1. **Cross-reference id** (`gsis`, `sportradar`, `espn`, `fantasydata`) against the DynastyProcess map.
2. **Team defense** by team abbreviation, which *is* Sleeper's `DEF` player id.
3. **Name + team + position**, then **name + position**.

Names are compared on letters only, so `D.J.`/`DJ`, `Ja'Marr`/`JaMarr` and a `Jr.` present in one
source but not the other all match. Relocated abbreviations (`OAK`→`LV`, `SD`→`LAC`, `STL`/`LA`→`LAR`)
are normalized. Every candidate id is checked back against the synchronized Sleeper directory, because
an identity map retains ids for players Sleeper has since removed.

A row that matches **several** Sleeper players resolves to none, and every candidate is reported for
manual adjudication. A row whose position disagrees with Sleeper's is refused rather than mapped — a
mismapped identity is worse than a missing one, because it attributes one player's projection to
another and every downstream number stays plausible. Unresolved rows appear in
`IngestionReport.unresolved` with a reason (`no-match`, `ambiguous`, `not-in-sleeper`,
`position-mismatch`, `inactive`) and the exact count in `unresolvedTotal`.

### Derived fields

Two of Sleeper's requirements are met by no projection source, so the adapter derives them and marks
them as derived. Notes travel in `IngestionReport.derivations`, never inside the forecast objects —
the position contracts reject unknown fields, and a derived distribution must not be able to
masquerade as a source-supplied one downstream.

| Field | Method | Basis |
| --- | --- | --- |
| `fgm_50_59` / `fgm_60p` | Sources publish one 50-plus band. Attempts split 90/10; makes apportioned by *expected* makes, so the long band is not credited with accuracy it does not have. | nflverse play-by-play |
| Kicker attempts by band | SportsDataIO publishes makes by distance and attempts only in total; attempts are recovered by inverting each band's make rate and rescaling to the published total, so `fgmiss` lands at plausible distances. | nflverse play-by-play |
| `longAttemptProbability` | `1 - exp(-expected long attempts)` — P(at least one), not the share of attempts. | Poisson arrival |
| `pts_allow_*`, `yds_allow_*` | Sources publish a *mean*; Sleeper prices each tier at its probability. A continuity-corrected normal over the tiers, renormalized to sum to 1. | nflverse, sigma from game-level dispersion |

A defense projected to allow 17 points has not earned the shutout bonus; it has a probability of one.
A better matchup raises `P(shutout)` and therefore the bonus's expected value — it never grants the
bonus. Constants live in `NFLVERSE_BASIS` in
[`derivation.ts`](../apps/api/src/providers/derivation.ts) so they can be re-estimated from a later
observation window without touching the logic. A source that begins publishing real distributions is
passed straight through and nothing is derived.

### Category coverage

Coverage is computed against the **live** league's validated `complete-live` scoring snapshot, because
a feed is complete or incomplete only relative to one commissioner's rules. Rules the league sets to
zero create no obligation. `IngestionReport.coverage` reports, per position family: which rules the
league pays, which the feed supplies, which it does not, and which were derived. Anything missing is
*recorded* — never inferred, filled, or rounded to zero, matching the rule the special-teams contract
already applies. Without a `complete-live` snapshot, coverage is reported as unassessed rather than
assumed complete.

### Known coverage gaps with this source

- **No floor or ceiling scenarios.** SportsDataIO is mean-only. Nothing is invented — the codebase's
  existing rule is that a missing floor is never fabricated — so `scenarios.supported` is `false` and
  floor/ceiling analysis is unavailable. A source with distributional or DFS ceiling output would fill
  this without any change to the pipeline.
- **No individual `st_*` production.** Return touchdowns, forced fumbles and fumble recoveries for a
  rostered returner are not modelled, so a league that scores them will see those three categories in
  `coverage.uncovered`. Per [special-teams.md](special-teams.md), they contribute nothing and promote
  nobody.
- **Team `def_st_ff` / `def_st_fum_rec` are zero, not modelled.** The source publishes special-teams
  touchdowns for a unit but not its kicking-game fumbles.
- **Opportunity is targets only.** Routes, route participation, target share and red-zone targets are
  not published, so the floor-lift and pass-catching-back analysis in [lineup.md](lineup.md) has less
  to work with.

## Retry policy and source outages

Requests use a bounded timeout (15s projections, 30s bulk CSV) and at most **three retries** with
exponential backoff and full jitter, capped at 20s per wait. Jitter matters because several ingestion
jobs retrying a recovering source must not resynchronize onto it.

| Condition | Retried | Why |
| --- | --- | --- |
| 429 | Yes, honouring `Retry-After` | The source said how long to wait; backing off less is rate-limited harder |
| 5xx, timeout, network | Yes | Transient |
| 401 / 403 | **No** | A second attempt spends quota on the same wrong key |
| 404 | **No** | A missing resource, not an outage |
| 200 with the wrong shape | **No** | Retrying will not change it; treated as a validation failure |

**Degradation is deliberate and asymmetric.** The identity map cannot degrade — without it every
provider id is unmappable. Bye weeks and injury reports can: a failure there is recorded in
`IngestionReport.errors` and the run continues, because a complete set of projections is still worth
publishing. If the projections fetch itself fails, the run is `failed`, an alert fires, and **the last
good feed is left exactly where it was**.

**Nothing is written until validation passes.** A candidate feed that fails `parseWaiverSignals` is
`rejected`; the previous feed keeps serving and the schema error is reported. A bad upstream day
cannot replace a good feed with a worse one.

## Staleness

The last good feed is always retained. Staleness is evaluated at **read** time, not stamped at write
time, because it is a function of *now* — a feed written twenty minutes ago and one written twenty
hours ago are the same bytes.

`ProjectionFeedStore.state()` returns the retained feed with `stale`, `ageMs` and a `staleReason` for
inspection. `ProjectionFeedStore.load()` — the `WaiverSignalProvider` the waiver, lineup and trade
endpoints consume — returns `null` once past `PROJECTION_FEED_STALE_HOURS`, or for a different season
or week, which those engines surface as the documented explicit unavailable state. Serving last week's
projection as though it were this week's is the one failure a manager cannot detect from the
recommendation itself.

## Service levels and alerting

| Kind | Default threshold | Severity |
| --- | --- | --- |
| `schema` | Candidate must validate | **critical** |
| `volume` | ≥ 300 players | **critical** |
| `identity` | ≥ 95% resolved | warning, critical below 76% |
| `freshness` | Source timestamp ≤ 6h old | warning, critical past 12h |
| `coverage` | Every scored rule supplied | warning (critical if `REQUIRE_COMPLETE_COVERAGE`) |

Alerts always go to stderr as one structured line, where a container's log pipeline collects them, and
additionally to `PROJECTION_FEED_ALERT_WEBHOOK` when set. A webhook failure never fails an ingestion:
a feed that published correctly must not be discarded because a chat integration was down.

## Schedule

Windows are interpreted in `PROJECTION_FEED_TIME_ZONE` (default `America/New_York`), because the NFL's
week is defined in Eastern time and a server that moves regions must not shift the waiver preflight run
into the window it was meant to precede.

| Window | When (Eastern) | Why |
| --- | --- | --- |
| `waiver-preflight-evening` | Tue 21:00 | Leaves time to notice a failed run and re-run it by hand |
| `waiver-preflight-final` | Wed 01:30 | The last run before standard waivers process |
| `injury-report-wednesday/thursday` | Wed, Thu 18:00 | After each day's practice report |
| `injury-report-friday` | Fri 17:00 | After the final game-status report |
| `injury-report-saturday` | Sat 13:00 | Elevations and weekend status changes |
| `gameday-thursday` | Thu 18:00–24:00, every 30 min | Kickoff window |
| `gameday-sunday` | Sun 08:00–24:00, every 15 min | Inactives land ~90 minutes before kickoff |
| `gameday-monday` | Mon 18:00–24:00, every 30 min | Kickoff window |
| `baseline` | Daily 06:00–22:00, every 6h | Keeps the feed moving between the windows that matter |

Each run schedules the next rather than firing on a fixed interval, so the schedule cannot drift
against wall-clock windows or queue runs back to back after a slow ingestion. Ingestion is
single-flight: overlapping triggers share one run rather than racing on the same rename. The process
ingests once at startup so a restart after an outage does not wait for the next window. A failed run
never stops the schedule — the next window is the retry.

**Horizontally scaled deployments** must run the schedule on exactly one worker, or hold a distributed
lock, as [architecture.md](architecture.md) already requires of interval work.

## Storage

The file repository writes to a temporary file, `fsync`s it, then renames. The rename is what makes a
reader see either the old feed or the new one and never a partial file; the `fsync` is what keeps that
true after a power loss.

For a scaled deployment, implement `FeedRepository` against PostgreSQL — `read` and `write` are the
whole interface, and `write` is only ever called with an already-validated feed:

```sql
CREATE TABLE projection_feeds (
  season      text        NOT NULL,
  week        integer     NOT NULL,
  feed        jsonb       NOT NULL,
  provenance  jsonb       NOT NULL,
  report      jsonb       NOT NULL,
  ingested_at timestamptz NOT NULL,
  PRIMARY KEY (season, week)
);
CREATE INDEX projection_feeds_ingested_at ON projection_feeds (ingested_at DESC);
```

`write` becomes an upsert on `(season, week)`, which gives the same atomicity the rename does. Read
the newest row; staleness is still computed from `ingested_at` at read time.

## Manual recovery

**1. Establish what is actually wrong.** The stored feed carries the report that produced it:

```bash
jq '{status: .report.status, provenance: .provenance, breaches: .report.breaches, errors: .report.errors, identity: .report.identity, uncovered: .report.coverage.uncovered}' data/projection-feed.json
```

**2. Match the symptom.**

| Symptom | Action |
| --- | --- |
| `status: "failed"`, `unauthorized` in errors | The subscription key is wrong, expired, or lacks the endpoint's scope. Set `SPORTSDATAIO_API_KEY` and restart. |
| `status: "rejected"` | Read `report.schema.error`; it names the exact field. The previous feed is still serving. If the source has changed shape, fix the driver — do not relax the schema. |
| `identity` breach | Inspect `report.unresolved`. A cluster of `no-match` usually means the DynastyProcess map has not caught up with roster moves; it refreshes on its own cadence and the next run typically clears it. A cluster of `ambiguous` needs a cross-id added to the source rows. |
| `freshness` breach with a successful fetch | The source has stopped publishing. Check their status page. Ingestion is healthy; nothing here will fix it. |
| `volume` breach | Almost always an outage that answered 200 — an off-season week, or a wrong `NFL_SEASON`/week. Confirm with `curl` before changing thresholds. |
| `coverage` breach | Expected for the gaps listed above. Widen only after confirming the league actually scores the named rules. |
| Stale but healthy | The schedule is not running. Confirm exactly one worker starts it and the process was not restarted into a state where `PROJECTION_FEED_ENABLED` is unset. |

**3. Force a run out of band.** Ingestion is idempotent and single-flight, so this is safe at any time:

```bash
npm run ingest -w @sleeper/api -- 2026 8
```

**4. Roll back to a known-good feed.** The store keeps one feed; keep your own backups if you need
history. Restore by writing the file atomically — never edit it in place, or a reader can observe a
half-written document:

```bash
cp data/projection-feed.backup.json data/projection-feed.json.tmp && mv data/projection-feed.json.tmp data/projection-feed.json
```

A restored feed is validated on read. If it fails, the store raises rather than letting a corrupted
document reach the scoring boundary as an unexplained batch of rejections.

**5. Fall back to the file adapter.** Unset `PROJECTION_FEED_ENABLED` and set `WAIVER_SIGNALS_PATH` to
a hand-maintained feed. The two adapters implement the same `WaiverSignalProvider` interface, so
nothing downstream changes.

**6. Accept unavailability.** With no usable feed, waiver, lineup and trade rankings report the
documented explicit unavailable state. That is the intended end state, not a failure to handle one:
every alternative involves showing a manager a number nothing supports.
