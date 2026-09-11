import { randomUUID } from 'node:crypto';
import { cookieName, issueSession } from '../auth.js';
import type { ApplicationUserRepository, SessionRepository } from '../storage/repositories.js';

/**
 * Signs in a distinct application user through the real session issuer, so route tests can assert that
 * authorization follows the session's own Sleeper identity rather than anything the request carries.
 */
export async function signedInAs(store: ApplicationUserRepository & SessionRepository, identity: { sleeperUserId?: string; leagueIds?: string[] } = {}) {
  const user = {
    id: randomUUID(), login: `test-${randomUUID()}`, passwordHash: 'disabled',
    sleeperUserId: identity.sleeperUserId, sleeperLeagueIds: identity.leagueIds ?? [], createdAt: new Date().toISOString(),
  };
  await store.saveApplicationUser(user);
  const issued = await issueSession(store, user);
  return { user, cookie: `${cookieName()}=${issued.rawSessionId}`, csrfToken: issued.csrfToken };
}
