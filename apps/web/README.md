# Huddle dashboard

Run `npm run dev` from the repository root to start the existing API and this app. The web development server proxies `/api` to port 4000, so it also works when port 5173 is already occupied. The initial view is an explicitly labeled fictional Week 8 league; use **Connect Sleeper** for public league data.

The dashboard prioritizes urgent alerts, start/sit decisions, matchup outlook, waiver upgrades, trade needs, then league activity and playoff context. Desktop layouts use a sidebar and comparison columns. Mobile layouts stack sections in the same order, provide a navigation menu, and turn waiver rows into compact cards. Tables that still need extra room scroll within their own regions.

Each proposed action opens a native modal with an individual checklist. Escape closes it, keyboard focus stays inside, and closing restores focus to the trigger. Completing a checklist or opening Sleeper never changes an action to “confirmed.” Only numeric league IDs can produce HTTPS links to Sleeper; links open the league without prefilling or submitting anything. Sample actions cannot open live leagues.

## Data coverage

- League rosters, ownership/co-ownership, scores, records, and transactions come from the existing API.
- Player names and current availability use Sleeper’s documented public player feed, cached in memory for up to 24 hours. A failed player request leaves the league usable and raises a partial-sync alert. This feed is current availability, not a historical injury report.
- Empty slots use the selected matchup’s starters when available.
- Live projections, waiver values, trade analysis, confidence scores, and playoff probabilities require an owner-scoped analysis source. They show explanatory empty states rather than sample values in a connected league. The legacy dashboard snapshot is not owner-scoped and is intentionally not used for personalized decisions.
- A live bye-week schedule is not supplied by the existing API. Coverage is explicitly labeled incomplete. The adapter can use `bye_week` when an authoritative source supplies it.
- Standings use winning percentage (ties count as half a win), then points for. Division rules can produce a different official playoff order.
- The full sample experience uses fictional players and illustrative values; it is not current NFL advice.

Reference: [Sleeper’s public API documentation](https://docs.sleeper.com/).

## Verification

`npm run test -w @sleeper/web` runs dashboard model, API failure, rendered-state, and recommendation-boundary checks. `npm run build -w @sleeper/web` type-checks and bundles the app. The browser interaction checklist below is for manual QA; it is not automated by the render tests.

- At desktop, tablet, and 390px widths, follow the six sections in priority order; verify no page-wide horizontal scrolling.
- Use only the keyboard to navigate, open a recommendation, toggle checks, close with Escape, and confirm focus returns to its trigger.
- Switch matchup tabs with arrow keys, filter waivers to an empty position, and expand standings.
- On mobile, open and close navigation and inspect the waiver cards.
- Connect a league; while loading, confirm no sample advice appears. Refresh with the API unavailable; verify the last successful view remains and a sync error appears.
- Reconnect or change leagues/weeks and confirm stale results and checklist state are not carried into another selection.

For a separately hosted frontend, configure `VITE_API_URL`, allow only the exact frontend origin, and send requests over HTTPS. Authentication uses the server-issued host-only session cookie; never put authentication secrets in Vite variables.
