# Owner command center

`GET /api/command-center/:leagueId?week=8` authenticates with the application session,
checks the linked league, and resolves the owner's or co-owner's roster on the server.
A client cannot choose another roster or owner. Missing/invalid weeks return 400,
unlinked leagues and non-owners return 403, and a league with no stored snapshot
returns 404. Responses use `Cache-Control: private, no-store`.

The optional numeric trade bounds are the same as `/api/trades/:leagueId` (for
example `maxValueGap=.25&maxRisk=.65`). Invalid or unknown parameters return 400
before synchronization. Manual synchronization remains `POST /api/sync/:leagueId`;
rechecking recommendations simply requests another complete command center.

## Consistent inputs

`CommandCenterService` attempts one league synchronization, then uses one atomic
store read for league rules, rosters, users, selected-week matchups, transactions,
players, pick transfers and freshness. A failed sync retains available stored data
and discloses the failure. Authorization failures are never downgraded to optional
section failures.

One forecast load is validated and deeply frozen. Already validated immutable
snapshots are recognized by identity, so the file provider and trade engine do not
repeat forecast schema parsing. All engines receive the same frozen league,
rosters, player directory and forecast. Selected-week submitted starters take
precedence over current starters. Missing selected-week lineups are disclosed.
Engines still score raw statistics using their own horizon and availability
policies; reusing a trade score as a lineup score would change those semantics.

Every section cites `provenance.scoringSnapshotId` and
`provenance.forecastUpdatedAt`, including sections whose prerequisite checks stop
analysis early. The report payloads cite those same selected inputs. Matchup
outlook comes from the lineup report rather than another engine invocation.

## Sections and readiness

`sections` contains `snapshot`, `scoring`, `alerts`, `lineup`, `matchup`, `waivers`,
`trades`, and `freshness`. Each has `{ state, data, warnings, provenance }`:

- `ready`: the section's requirements are met.
- `partial`: useful results remain, but coverage, probability scenarios, or refresh
  checks are incomplete. Informational engine warnings can accompany ready data.
- `unavailable`: prerequisites or applicable data are absent; for example missing
  scoring, a missing forecast, disabled trading, or no opponent matchup.
- `stale`: a dependency is too old or future-dated. Retained data can be included;
  this state is not permission to act on it. Forecasts expire after 48 hours,
  ownership after 10 minutes, and availability metadata after 24 hours.
- `error`: an engine or forecast load/validation failed. Messages are sanitized;
  provider paths and internal exceptions are never returned.

An engine exception affects only its section and dependent sections (a lineup
failure also affects matchup). Starter empty-slot and metadata availability checks
continue without forecasts; missing bye coverage is explicit. Freshness lists
missing sources as unavailable, as well as timestamps for available sources.

## Frontend

Connected dashboards issue one command-center query. Lineup and matchup share its
lineup report; waiver and trade panels receive controlled reports and never issue
independent engine requests. Refreshes, panel rechecks, week/league changes and
trade-bound changes replace the response together. Requests are aborted on changes,
and result keys include the account, league, week and bounds to avoid showing a
previous selection's results. Section states and common provenance are visible;
source timestamps and warnings are expandable. Explicit fictional demo panels
retain their separate sample scenarios and are not used for connected leagues.
