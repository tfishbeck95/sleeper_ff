import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

// Runs against a deployed origin and a dedicated, already-connected staging account. No reset,
// account linking, fixture injection or licensed forecast calls. No traces containing staging data.
export async function smoke({ baseUrl, login, password, leagueId, week, ignoreHTTPSErrors = false }) {
  const origin = new URL(baseUrl);
  assert.equal(origin.protocol, 'https:', 'Smoke tests require HTTPS');
  assert.equal(origin.origin + '/', origin.href, 'Supply a staging origin, without a path/query/credentials');
  assert.ok(login && password && /^\d+$/.test(leagueId) && Number.isInteger(week) && week >= 1 && week <= 18, 'Configure a dedicated staging login, linked league and week');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors }); const page = await context.newPage();
    for (const path of ['/health/live', '/health/ready']) {
      const response = await context.request.get(`${origin.origin}${path}`); assert.equal(response.status(), 200, `${path} failed`);
    }
    const failures = []; page.on('pageerror', () => failures.push('Browser application error'));
    await page.goto(origin.origin, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.getByLabel('Login', { exact: true }).fill(login); await page.getByLabel('Password', { exact: true }).fill(password);
    const signedIn = page.waitForResponse(r => new URL(r.url()).pathname === '/auth/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    assert.equal((await signedIn).status(), 200, 'Staging sign-in failed');
    const cookie = (await context.cookies()).find(c => c.name === '__Host-huddle_session');
    assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict', 'Production session cookie policy failed');
    const session = await context.request.get(`${origin.origin}/auth/session`); assert.equal(session.status(), 200);
    assert.ok((await session.json()).user.sleeperLeagueIds.includes(leagueId), 'The smoke account must already link its dedicated test league');
    const response = await context.request.get(`${origin.origin}/api/command-center/${leagueId}?week=${week}`, { timeout: 30_000 });
    assert.equal(response.status(), 200, 'Staging command center failed'); const result = await response.json();
    assert.equal(result.leagueId, leagueId); assert.ok(result.sections.snapshot.data?.roster, 'Saved roster is unavailable');
    assert.notEqual(result.sections.snapshot.state, 'error');
    for (const name of ['lineup', 'waivers', 'trades']) {
      assert.notEqual(result.sections[name].state, 'error', `${name} failed`);
      assert.deepEqual(result.sections[name].provenance, result.provenance, 'Mixed recommendation snapshots');
    }
    await page.reload(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('heading', { name: 'Sign in to Huddle.' }).waitFor();
    assert.equal((await context.request.get(`${origin.origin}/auth/session`)).status(), 401, 'Sign-out did not revoke the session');
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await smoke({ baseUrl: process.env.STAGING_BASE_URL, login: process.env.STAGING_SMOKE_LOGIN,
      password: process.env.STAGING_SMOKE_PASSWORD, leagueId: process.env.STAGING_SMOKE_LEAGUE_ID, week: Number(process.env.STAGING_SMOKE_WEEK) });
    console.log('Staging smoke passed: readiness, compiled browser, sign-in, saved league, snapshot consistency and sign-out.');
  } catch { console.error('Staging smoke failed. Check staging configuration, readiness, sign-in and the dedicated league. No credentials or user data were logged.'); process.exitCode = 1; }
}
