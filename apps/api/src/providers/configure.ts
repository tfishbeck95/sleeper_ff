import { resolve } from 'node:path';
import type { ScoringRules } from '@sleeper/domain';
import { interpretLeagueRules } from '@sleeper/domain';
import type { LeagueRepository, PlayerRepository } from '../storage/repositories.js';

/** Ingestion reads the live leagues' rules and resolves identities against the shared directory. */
type ProjectionFeedRepository = LeagueRepository & PlayerRepository;
import { FileFeedRepository, ProjectionFeedStore } from './feed-store.js';
import { ProjectionIngestionService } from './ingest.js';
import { NflverseReferenceProvider } from './nflverse.js';
import type { ProjectionProvider, ReferenceDataProvider } from './provider.js';
import { IngestionSchedule, type ScheduleOptions } from './schedule.js';
import { CompositeAlerter, ConsoleAlerter, DEFAULT_SERVICE_LEVEL, WebhookAlerter, type Alerter, type ServiceLevel } from './service-level.js';
import { SportsDataIoProvider } from './sportsdataio.js';

/**
 * Builds the feed adapter from the process environment.
 *
 * The adapter is opt-in and stays entirely absent unless configured, so an installation with no data
 * licence behaves exactly as it did before: the file-based `WAIVER_SIGNALS_PATH` adapter still works,
 * and nothing starts reaching for a credential that was never issued.
 */

const number = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };
const flag = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

export const projectionFeedEnabled = (env: NodeJS.ProcessEnv = process.env) => flag(env.PROJECTION_FEED_ENABLED);

export function serviceLevelFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceLevel {
  return {
    minIdentityMatchRate: number(env.PROJECTION_FEED_MIN_IDENTITY_MATCH, DEFAULT_SERVICE_LEVEL.minIdentityMatchRate),
    maxSourceAgeMs: number(env.PROJECTION_FEED_MAX_SOURCE_AGE_HOURS, 6) * 3_600_000,
    maxIngestionAgeMs: number(env.PROJECTION_FEED_STALE_HOURS, 12) * 3_600_000,
    requireCompleteCoverage: flag(env.PROJECTION_FEED_REQUIRE_COMPLETE_COVERAGE),
    minPlayers: number(env.PROJECTION_FEED_MIN_PLAYERS, DEFAULT_SERVICE_LEVEL.minPlayers),
  };
}

export function alerterFromEnv(env: NodeJS.ProcessEnv = process.env): Alerter {
  const console = new ConsoleAlerter();
  const webhook = env.PROJECTION_FEED_ALERT_WEBHOOK?.trim();
  return webhook ? new CompositeAlerter([new WebhookAlerter(webhook, fetch, console)]) : console;
}

/**
 * The current NFL regular-season week, anchored to the Thursday after Labor Day.
 *
 * The week rolls over on Tuesday rather than at midnight Sunday, matching the boundary the league's
 * transaction week actually uses: Monday night's game belongs to the week that is ending, and waiver
 * processing opens the week that is starting.
 */
export function currentNflWeek(now = new Date(), env: NodeJS.ProcessEnv = process.env): { season: string; week: number } {
  const configuredSeason = env.NFL_SEASON?.trim();
  const anchor = env.NFL_WEEK_ONE_TUESDAY?.trim();
  const year = configuredSeason ? Number(configuredSeason) : (now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear());
  const start = anchor ? new Date(anchor) : weekOneTuesday(year);
  const elapsed = Math.floor((now.getTime() - start.getTime()) / (7 * 86_400_000));
  return { season: String(year), week: Math.min(18, Math.max(1, elapsed + 1)) };
}

/** Labor Day is the first Monday of September; week 1 opens the Tuesday of that same week. */
function weekOneTuesday(year: number): Date {
  const september = new Date(Date.UTC(year, 8, 1));
  const laborDay = new Date(september);
  laborDay.setUTCDate(1 + ((8 - september.getUTCDay()) % 7));
  return new Date(laborDay.getTime() + 86_400_000);
}

export interface ProjectionFeedRuntime {
  store: ProjectionFeedStore;
  ingestion: ProjectionIngestionService;
  schedule: IngestionSchedule;
}

export interface ConfigureOptions {
  env?: NodeJS.ProcessEnv;
  projections?: ProjectionProvider;
  reference?: ReferenceDataProvider;
  schedule?: ScheduleOptions;
  now?: () => Date;
}

/**
 * Wires the adapter, or returns null when it is not configured.
 *
 * The scoring accessor deliberately reads whichever connected league has a validated complete-live
 * snapshot rather than taking a league id: coverage is a property of the rules a feed has to satisfy,
 * and in a single-tenant deployment every connected league is asking the same question of the source.
 * A deployment serving materially different rule sets should pass its own accessor per league.
 */
export function configureProjectionFeed(store: ProjectionFeedRepository, options: ConfigureOptions = {}): ProjectionFeedRuntime | null {
  const env = options.env ?? process.env;
  if (!projectionFeedEnabled(env)) return null;

  const level = serviceLevelFromEnv(env);
  const feedStore = new ProjectionFeedStore(new FileFeedRepository(resolve(env.PROJECTION_FEED_PATH ?? '../../data/projection-feed.json')), level);
  const ingestion = new ProjectionIngestionService({
    projections: options.projections ?? new SportsDataIoProvider(),
    reference: options.reference ?? new NflverseReferenceProvider(),
    store: feedStore,
    sleeperPlayers: () => store.allPlayers(),
    scoring: () => liveScoringRules(store),
    level, alerter: alerterFromEnv(env), now: options.now,
  });
  const schedule = new IngestionSchedule(ingestion, () => currentNflWeek(options.now?.() ?? new Date(), env), {
    timeZone: env.PROJECTION_FEED_TIME_ZONE, now: options.now, ...options.schedule,
  });
  return { store: feedStore, ingestion, schedule };
}

/**
 * The first connected league whose scoring snapshot is complete and live, or null when none is.
 *
 * Null is the honest answer rather than a fallback to the documented reference rates: coverage
 * assessed against rules no commissioner actually set would report a gap this league does not have,
 * or hide one it does.
 */
async function liveScoringRules(store: ProjectionFeedRepository): Promise<ScoringRules | null> {
  for (const league of await store.allLeagues()) {
    const rules = interpretLeagueRules(league);
    if (rules.scoring.actionable) return rules.scoring;
  }
  return null;
}
