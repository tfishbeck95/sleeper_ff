import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../store.js';
import { repositoryContract } from './contract.js';

/**
 * The JSON adapter against the shared conformance suite.
 *
 * A PostgreSQL adapter passes this same suite from a test file of its own, pointed at a throwaway
 * database — which is what makes the two interchangeable rather than merely similar.
 */
repositoryContract('json', async () => new JsonStore(join(await mkdtemp(join(tmpdir(), 'huddle-repository-')), 'store.json')));
