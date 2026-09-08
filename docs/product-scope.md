# Product scope

## Supported workflows

Huddle gives a fantasy manager a single, responsive view of their Sleeper league: matchup projections, roster context, league standing, and explainable lineup, waiver-watch, and trade recommendations. A user connects by public Sleeper username and selects a league. The application reads supported public Sleeper API resources and periodically refreshes its stored snapshot.

Recommendations are advisory. Huddle may generate and prioritize suggested starts, waiver targets, and trade ideas, but the user must confirm and execute every roster, lineup, waiver, and trade change directly in Sleeper. The interface must preserve this boundary anywhere it presents an action.

## API constraints

- Use documented, supported `https://api.sleeper.app/v1` read endpoints only.
- Cache player metadata and league snapshots to respect upstream availability and avoid unnecessary traffic.
- Treat upstream data as eventually consistent. Display the last successful synchronization time.
- Use bounded timeouts, encode path parameters, and retain the last good snapshot if a refresh fails.
- Public Sleeper identifiers are not secrets; application sessions and internal API tokens are.

## Explicit non-goals

Huddle does **not** make roster changes, submit waiver claims, accept or propose trades, or change lineups. Undocumented API calls, reverse-engineered endpoints, browser/session-cookie automation, credential collection, and storing Sleeper passwords are out of scope. Huddle is not a gambling product and does not promise outcomes or replace user judgment.

The initial release also excludes commissioner tools, payments, chat, native mobile apps, and historical play-by-play ingestion.
