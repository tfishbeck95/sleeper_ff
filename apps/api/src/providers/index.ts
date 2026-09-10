/**
 * The projection and injury provider adapter.
 *
 * Ingestion produces raw statistics under Sleeper player ids and writes a validated feed; the league's
 * own rules turn those statistics into points later, at the single scoring boundary. Nothing here
 * scores anything, and nothing here is served to a browser — the projection licence permits use, not
 * redistribution. See docs/projection-provider.md.
 */
export { assessCoverage, familiesFor, type CoverageReport, type Family, type FamilyCoverage } from './coverage.js';
export { alerterFromEnv, configureProjectionFeed, currentNflWeek, projectionFeedEnabled, serviceLevelFromEnv, type ConfigureOptions, type ProjectionFeedRuntime } from './configure.js';
export { deriveDefenseForecast, deriveKickerForecast, NFLVERSE_BASIS, type DerivationNote, type EmpiricalBasis } from './derivation.js';
export { FileFeedRepository, InMemoryFeedRepository, ProjectionFeedStore, type FeedRepository, type FeedState, type StoredFeed } from './feed-store.js';
export { ProviderFetchError, ProviderHttpClient, requireCredential } from './http.js';
export { normalizeName, normalizeTeam, resolveIdentities, type IdentityResolution, type MatchMethod } from './identity.js';
export { mergeInjury, ProjectionIngestionService, type IngestionDependencies } from './ingest.js';
export { NflverseReferenceProvider, NFLVERSE_LICENSE, parseCsv } from './nflverse.js';
export type {
  FeedProvenance, IdentityLink, ProjectionProvider, ProviderCapabilities, ProviderDefenseLine, ProviderFetch,
  ProviderIdentity, ProviderInjury, ProviderKickerLine, ProviderPlayerProjection, ProviderWeekProjection,
  ReferenceDataProvider, SourceLicense, UnresolvedIdentity, UnresolvedReason,
} from './provider.js';
export { DEFAULT_TIME_ZONE, DEFAULT_WINDOWS, IngestionSchedule, nextRun, type ScheduleWindow } from './schedule.js';
export {
  CompositeAlerter, ConsoleAlerter, DEFAULT_SERVICE_LEVEL, evaluateServiceLevel, stalenessOf, WebhookAlerter,
  type Alerter, type AlertEvent, type IngestionReport, type ServiceLevel, type ServiceLevelBreach,
} from './service-level.js';
export { SportsDataIoProvider, SPORTSDATAIO_CAPABILITIES, SPORTSDATAIO_LICENSE } from './sportsdataio.js';
