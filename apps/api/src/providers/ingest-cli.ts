import { createRepository } from '../storage/index.js';
import { configureProjectionFeed, currentNflWeek } from './configure.js';

/**
 * Out-of-band ingestion, for the manual recovery procedure in docs/projection-provider.md.
 *
 * Runs exactly the scheduled path, so a hand-triggered recovery cannot diverge from the automated
 * one. Ingestion is idempotent and single-flight, so this is safe to run while the API is up: a
 * rejected candidate still leaves the last good feed in place.
 *
 *   npm run ingest -w @sleeper/api            # the current season and week
 *   npm run ingest -w @sleeper/api -- 2026 8  # a specific week
 */
const [seasonArg, weekArg] = process.argv.slice(2);
const current = currentNflWeek();
const season = seasonArg ?? current.season;
const week = weekArg ? Number(weekArg) : current.week;

if (!/^\d{4}$/.test(season) || !Number.isInteger(week) || week < 1 || week > 18) {
  console.error(`Usage: npm run ingest -w @sleeper/api -- <season> <week 1-18>. Received "${season}" "${weekArg ?? ''}".`);
  process.exit(2);
}

// The same adapter selection the API makes, so a recovery run cannot write somewhere the API is not
// reading from.
const runtime = configureProjectionFeed(createRepository().repository);
if (!runtime) {
  console.error('PROJECTION_FEED_ENABLED is not set. See docs/projection-provider.md.');
  process.exit(2);
}

const report = await runtime.ingestion.ingest(season, week);
console.info(JSON.stringify({
  status: report.status, season: report.season, week: report.week, players: report.players,
  omitted: report.omitted, identity: report.identity, unresolvedTotal: report.unresolvedTotal,
  coverage: report.coverage && { complete: report.coverage.complete, uncovered: report.coverage.uncovered },
  scenarios: report.scenarios, schema: report.schema, derivations: report.derivations.length,
  breaches: report.breaches, errors: report.errors, provenance: report.provenance,
}, null, 2));

// A rejected or failed run must not look like a success to a shell script or a CI step.
process.exit(report.status === 'published' ? 0 : 1);
