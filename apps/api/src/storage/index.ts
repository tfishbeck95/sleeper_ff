/**
 * Storage.
 *
 * `repositories.ts` is the contract every adapter implements, `records.ts` the records it moves,
 * `configure.ts` the explicit selection between adapters, and `contract.ts` the conformance suite an
 * adapter has to pass. The JSON adapter lives in `../store.ts`; the PostgreSQL schema lives in
 * `apps/api/migrations`. See docs/storage.md.
 */
export * from './records.js';
export * from './repositories.js';
export { createRepository, describeStorage, instanceMode, storageConfiguration, StorageConfigurationError, type InstanceMode, type StorageConfiguration } from './configure.js';
export { checkMigrations, loadMigrations, MIGRATIONS_DIR, type Migration } from './migrations.js';
