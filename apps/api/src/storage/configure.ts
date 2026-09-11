import { resolve } from 'node:path';
import { PostgresStore } from './postgres.js';
import { JsonStore } from '../store.js';
import type { HuddleRepository, RepositoryAdapter } from './repositories.js';

/**
 * Which adapter this process talks to, and whether it is allowed to.
 *
 * Storage is chosen by configuration, not by inference. Outside development `STORAGE_ADAPTER` has to
 * name the adapter: a deployment that silently fell back to a file because a variable was missing is
 * exactly the failure this refuses, and it is the kind that is only noticed when two instances have
 * been overwriting each other's writes for a week.
 *
 * The JSON adapter is a local development profile. Its writes are atomic within one process — one
 * queue, one temporary file, one rename — and that is all a file can promise: two processes sharing a
 * document interleave between read and rename, so the later write silently discards the earlier one,
 * and the lease that is supposed to keep one worker in charge of the schedule is taken by both. So a
 * multi-instance production deployment is refused rather than warned about.
 */

export type InstanceMode = 'single' | 'multi';

export class StorageConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'StorageConfigurationError'; }
}

export interface StorageConfiguration {
  adapter: RepositoryAdapter;
  instanceMode: InstanceMode;
  /** True when the adapter was defaulted rather than named — only possible outside production. */
  defaulted: boolean;
  /** Where the JSON adapter keeps its document. */
  dataFile?: string;
  /** The PostgreSQL connection string. Never logged: it carries a password. */
  databaseUrl?: string;
  /** Configuration that is allowed but worth saying out loud. */
  warnings: string[];
}

const ADAPTERS: readonly RepositoryAdapter[] = ['json', 'postgres'];
const production = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

/**
 * How many instances share this storage.
 *
 * `APP_INSTANCE_MODE` states it. When it is unset, one signal is trusted in production: an instance
 * with `SYNC_WORKER_ENABLED=false` has been told another instance owns the schedule, which is only
 * true of a fleet. Inferring `multi` from that is deliberately the cautious direction — it can refuse
 * a single-instance deployment that opted out of its own worker, which is a misconfiguration worth
 * stopping for, and it cannot let a fleet quietly run on a file.
 */
export function instanceMode(env: NodeJS.ProcessEnv = process.env): InstanceMode {
  const configured = env.APP_INSTANCE_MODE?.trim().toLowerCase();
  if (configured === 'single' || configured === 'multi') return configured;
  if (configured) throw new StorageConfigurationError(`Refusing to start: APP_INSTANCE_MODE must be 'single' or 'multi', not '${env.APP_INSTANCE_MODE}'.`);
  return production(env) && env.SYNC_WORKER_ENABLED?.trim().toLowerCase() === 'false' ? 'multi' : 'single';
}

export function storageConfiguration(env: NodeJS.ProcessEnv = process.env): StorageConfiguration {
  const mode = instanceMode(env);
  const named = env.STORAGE_ADAPTER?.trim().toLowerCase();
  if (named && !ADAPTERS.includes(named as RepositoryAdapter)) {
    throw new StorageConfigurationError(`Refusing to start: STORAGE_ADAPTER must be one of ${ADAPTERS.join(', ')}, not '${env.STORAGE_ADAPTER}'.`);
  }
  if (!named && production(env)) {
    throw new StorageConfigurationError(`Refusing to start: production requires STORAGE_ADAPTER to name the storage adapter explicitly (${ADAPTERS.join(' or ')}).`);
  }
  const adapter = (named ?? 'json') as RepositoryAdapter;
  const warnings: string[] = [];

  if (adapter === 'json') {
    if (mode === 'multi' && production(env)) {
      throw new StorageConfigurationError(
        'Refusing to start: the JSON adapter cannot back a multi-instance production deployment. '
        + 'Its writes are atomic only within one process, so instances overwrite each other and both take the same lease. '
        + 'Set STORAGE_ADAPTER=postgres with DATABASE_URL, apply apps/api/migrations, or run a single instance with APP_INSTANCE_MODE=single.',
      );
    }
    if (mode === 'multi') {
      warnings.push('The JSON adapter is configured for multiple instances. Writes will be lost and leases will not hold; production refuses this configuration.');
    }
    if (production(env)) {
      warnings.push('The JSON adapter is a local development profile. It keeps one document on one volume, with no point-in-time recovery.');
    }
    return { adapter, instanceMode: mode, defaulted: !named, dataFile: resolve(env.DATA_FILE ?? '../../data/store.json'), warnings };
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new StorageConfigurationError('Refusing to start: STORAGE_ADAPTER=postgres requires DATABASE_URL.');
  return { adapter, instanceMode: mode, defaulted: false, databaseUrl, warnings };
}

/** A description safe to log: no connection string, no password. */
export function describeStorage(configuration: StorageConfiguration): string {
  const where = configuration.adapter === 'json' ? configuration.dataFile : new URL(configuration.databaseUrl!).pathname.replace(/^\//, '') || 'database';
  return `${configuration.adapter} adapter, ${configuration.instanceMode}-instance, ${where}`;
}

/**
 * Builds the repository the configuration selects.
 *
 * The PostgreSQL adapter uses the versioned relational schema and implements the same repository
 * contract as the local adapter. Migrations must finish before application processes start.
 */
export function createRepository(env: NodeJS.ProcessEnv = process.env): { repository: HuddleRepository; configuration: StorageConfiguration } {
  const configuration = storageConfiguration(env);
  if (configuration.adapter === 'postgres') {
    return { repository: new PostgresStore(configuration.databaseUrl!), configuration };
  }
  return { repository: new JsonStore(configuration.dataFile!), configuration };
}
