import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stack, eventually, PASSWORD } from '../support/stack.mjs';
import { LEAGUE, USER, COOWNER, year } from '../support/scenarios.mjs';
import { EXPECTED_SCORING, interpretLeagueRules } from '../../packages/domain/dist/index.js';
const test = base.extend({ app: async ({}, use, info) => {
  const app = await stack();
  try { await use(app); }
  finally { if (info.status !== info.expectedStatus) for (const [role, log] of Object.entries(app.logs)) await info.attach(`${role}.log`, { body: log, contentType: 'text/plain' }); await app.close(); }
} });
async function login(request, app, user = 'owner') {
  const response = await request.post(`${app.url}/auth/login`, { data: { login: user, password: PASSWORD } });
  expect(response.status()).toBe(200); return (await response.json()).csrfToken;
}
async function connect(request, app, username = 'fixture_owner', leagues = [LEAGUE], user = 'owner') {
  const csrf = await login(request, app, user);
  const response = await request.post(`${app.url}/api/account/sleeper`, { headers: { 'x-csrf-token': csrf }, data: { username, leagueIds: leagues } });
  expect(response.status()).toBe(200);
  await eventually(async () => (await app.store.leagueConnection(LEAGUE))?.lastStatus === 'success');
  return csrf;
}
async function command(request, app, league = LEAGUE) {
  const response = await request.get(`${app.url}/api/command-center/${league}?week=8`);
  expect(response.status(), await response.text()).toBe(200); return response.json();
}
async function openDashboard(page, app) {
  await page.goto(app.url); await page.getByLabel('Login', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Sleeper', exact: true }).click();
  await page.getByLabel('Sleeper username').fill('  fixture_owner  '); await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox', { name: /Contract League/ }).check();
  await page.getByRole('button', { name: 'Connect leagues' }).click();
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('heading', { name: /Let’s get your lineup ready/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Selected league' })).toHaveValue(LEAGUE);
  await expect(page.getByRole('status').filter({ hasText: 'League refreshed.' })).toBeVisible();
}

test('sign in, resume the session, sign out and reject the old cookie', async ({ app, page }) => {
  await page.goto(app.url); await page.getByLabel('Login', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('wrong'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid login or password.');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const cookie = (await page.context().cookies()).find(c => c.name === '__Host-huddle_session'); expect(cookie.httpOnly).toBe(true); expect(cookie.secure).toBe(true); expect(cookie.sameSite).toBe('Strict');
  await page.reload(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Huddle.' })).toBeVisible();
  const rejected = await page.request.get(`${app.url}/auth/session`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(rejected.status()).toBe(401);
});

test('resolve a username, reject invalid syntax and distinguish a missing user', async ({ app, request }) => {
  await login(request, app);
  const found = await request.get(`${app.url}/api/sleeper/users/fixture_owner`);
  expect(found.status()).toBe(200); expect((await found.json()).user_id).toBe(USER);
  expect((await request.get(`${app.url}/api/sleeper/users/nobody_here`)).status()).toBe(404);
  expect((await request.get(`${app.url}/api/sleeper/users/%20fixture_owner%20`)).status()).toBe(400);
});

test('discover three seasons and connect multiple leagues', async ({ app, request }) => {
  const csrf = await login(request, app);
  await request.post(`${app.url}/api/account/sleeper`, { headers: { 'x-csrf-token': csrf }, data: { username: 'fixture_owner', leagueIds: [] } });
  const found = await request.get(`${app.url}/api/sleeper/users/${USER}/leagues?seasons=${year},${Number(year)-1},${Number(year)-2}`);
  expect(found.status()).toBe(200); const data = await found.json();
  expect(data.seasons.map(s => s.leagues.length)).toEqual([2, 1, 1]);
  const selected = [LEAGUE, '920000000000000003'];
  const linked = await request.post(`${app.url}/api/account/sleeper`, { headers: { 'x-csrf-token': csrf }, data: { username: 'fixture_owner', leagueIds: selected } });
  expect(linked.status()).toBe(200); expect((await linked.json()).user.sleeperLeagueIds).toEqual(selected);
  expect((await command(request, app, selected[1])).season).toBe(String(Number(year)-1));
  expect((await command(request, app)).leagueId).toBe(LEAGUE);
});

for (const [username, account, id] of [['fixture_owner', 'owner', USER], ['fixture_coowner', 'coowner', COOWNER]]) {
  test(`match the ${account} to the same roster`, async ({ app, request }) => {
    await connect(request, app, username, [LEAGUE], account);
    const result = await command(request, app);
    expect(result.rosterId).toBe(1);
    const roster = result.sections.snapshot.data.roster;
    expect([roster.ownerId, ...roster.coOwnerIds]).toContain(id);
  });
}

test('complete live scoring feeds lineup, waivers and trades from one snapshot', async ({ app, request }) => {
  await connect(request, app); const result = await command(request, app);
  expect(result.sections.scoring.data.kind).toBe('complete-live');
  expect(result.sections.scoring.data.settings).toEqual(EXPECTED_SCORING);
  expect(result.sections.lineup.data.startSit.length).toBeGreaterThan(0);
  expect(result.sections.waivers.data.recommendations.length).toBeGreaterThan(0);
  for (const section of Object.values(result.sections)) expect(section.provenance).toEqual(result.provenance);
  for (const name of ['lineup', 'waivers', 'trades']) {
    expect(result.sections[name].state).not.toBe('error');
    expect(result.sections[name].data.scoringSnapshotId).toBe(result.provenance.scoringSnapshotId);
  }
  expect(result.sections.lineup.data.forecast.updatedAt).toBe(result.provenance.forecastUpdatedAt);
  expect(result.sections.waivers.data.forecastUpdatedAt).toBe(result.provenance.forecastUpdatedAt);
  expect(result.sections.trades.data.forecastUpdatedAt).toBe(result.provenance.forecastUpdatedAt);
});

for (const format of ['standard', 'ppr', 'dynasty', 'keeper', 'superflex', 'kicker', 'defense', 'mismatch', 'unavailable']) {
  test(`${format} league configuration is preserved and safely interpreted`, async ({ app, request }) => {
    app.upstream.set(format); await connect(request, app); const result = await command(request, app);
    const league = result.sections.snapshot.data.league; const rules = interpretLeagueRules(league);
    if (['standard', 'mismatch', 'unavailable'].includes(format)) {
      // The application's documented scoring contract requires the reference's complete PPR rules.
      // Other settings must be disclosed and advice withheld, never silently defaulted to PPR.
      expect(result.sections.scoring.state).toBe('unavailable');
      for (const name of ['lineup', 'waivers', 'trades']) expect(result.sections[name].data.status).toBe('unavailable');
      if (format === 'standard') expect(league.scoring.rawSettings.rec).toBe(0);
      if (format === 'mismatch') expect(league.scoring.issues.some(i => i.kind === 'mismatched' && i.key === 'pass_td')).toBe(true);
    } else expect(result.sections.scoring.state).toBe('ready');
    if (format === 'dynasty') expect(rules.format).toBe('dynasty');
    if (format === 'keeper') expect(rules.keepers.enabled).toBe(true);
    if (format === 'superflex') expect(league.rosterPositions[0].position).toBe('SUPER_FLEX');
    if (format === 'kicker') expect(result.sections.alerts.data.some(a => a.slot === 'K')).toBe(true);
    if (format === 'defense') expect(result.sections.alerts.data.some(a => a.slot === 'DEF')).toBe(true);
  });
}

for (const mode of ['fresh', 'stale', 'missing', 'malformed', 'partial']) {
  test(`${mode} forecasts retain the roster and expose recommendation readiness`, async ({ app, request }) => {
    await app.forecast(mode); await connect(request, app); const result = await command(request, app);
    expect(result.sections.snapshot.state).toBe('ready');
    const forecast = result.sections.freshness.data.find(s => s.source === 'forecast');
    expect(forecast.state).toBe({ fresh: 'ready', stale: 'stale', missing: 'unavailable', malformed: 'error', partial: 'ready' }[mode]);
    if (mode === 'fresh') expect(result.sections.lineup.data.startSit.length).toBeGreaterThan(0);
    if (mode === 'missing' || mode === 'malformed') expect(result.sections.lineup.data.status).toBe('unavailable');
    if (mode === 'partial') { expect(result.sections.lineup.data.status).not.toBe('ready'); expect(result.sections.lineup.warnings.length).toBeGreaterThan(0); }
    expect(JSON.stringify(result)).not.toContain('huddle-e2e-');
  });
}

for (const [name, faults, status, code, calls] of [
  ['timeout', ['timeout'], 504, 'upstream_timeout', null],
  ['rate limit', [429], 503, 'upstream_rate_limited', 1],
  ['404', [404], 404, 'upstream_not_found', 1],
  ['temporary 5xx', [503, null], 200, null, 2],
]) {
  test(`Sleeper ${name} uses the real HTTP retry policy`, async ({ app, request }) => {
    await login(request, app); const path = '/v1/user/fixture_owner'; app.upstream.fault(path, faults);
    const started = Date.now(); const result = await request.get(`${app.url}/api/sleeper/users/fixture_owner`);
    expect(result.status()).toBe(status); if (code) expect((await result.json()).code).toBe(code);
    if (status === 503) expect(result.headers()['retry-after']).toBe('30');
    if (calls) expect(app.upstream.counts.get(path)).toBe(calls);
    if (name === 'timeout') { expect(Date.now()-started).toBeLessThan(5_000); expect(app.upstream.counts.get(path)).toBeGreaterThan(0); }
  });
}

test('session authorization prevents another account from accessing a saved connection', async ({ app, playwright, request }) => {
  await connect(request, app);
  const stranger = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    const token = await login(stranger, app, 'stranger');
    for (const path of [`command-center/${LEAGUE}?week=8`, `lineup/${LEAGUE}?week=8`, `waivers/${LEAGUE}?week=8`, `trades/${LEAGUE}?week=8`, `sync/${LEAGUE}`, `players/${LEAGUE}`, `sleeper/leagues/${LEAGUE}`, `dashboard/${LEAGUE}`, `sleeper/users/${USER}/leagues`])
      expect((await stranger.get(`${app.url}/api/${path}`)).status()).toBe(403);
    expect((await stranger.post(`${app.url}/api/sync/${LEAGUE}`, { headers: { 'x-csrf-token': token } })).status()).toBe(403);
    expect((await stranger.get(`${app.url}/api/command-center/${LEAGUE}?week=8&userId=${USER}`)).status()).toBe(403);
    expect((await request.post(`${app.url}/api/sync/${LEAGUE}`)).status()).toBe(403); // CSRF is enforced.
  } finally { await stranger.dispose(); }
});

test('manual refresh coalesces with a background synchronization in another process', async ({ app, request }) => {
  const csrf = await connect(request, app); await app.stop('worker');
  await app.store.applySync({ freshness: { [`rosters:${LEAGUE}`]: '2020-01-01T00:00:00.000Z' } });
  await app.store.updateLeagueConnection(LEAGUE, { nextAttemptAt: '2020-01-01T00:00:00.000Z' });
  const path = `/v1/league/${LEAGUE}/rosters`; app.upstream.counts.clear(); const release = app.upstream.hold(path);
  try {
    await app.start('worker'); await eventually(() => app.upstream.counts.get(path) === 1);
    expect((await (await request.get(`${app.url}/api/sync/${LEAGUE}`)).json()).running).toBe(true);
    const responses = await Promise.all([1, 2].map(() => request.post(`${app.url}/api/sync/${LEAGUE}?force=true`, { headers: { 'x-csrf-token': csrf } })));
    expect(responses.map(r => r.status())).toEqual([202, 202]);
    // Starting a dashboard read while the worker publishes must not cause a competing fan-out.
    const read = command(request, app); release(); const result = await read;
    expect(app.upstream.counts.get(path)).toBe(1);
    for (const section of Object.values(result.sections)) expect(section.provenance).toEqual(result.provenance);
    await eventually(async () => !(await app.store.lease(`league-sync:league:${LEAGUE}`)));
    expect((await app.store.leagueConnection(LEAGUE)).lastStatus).toBe('success');
  } finally { release(); }
});

test('API and worker restarts retain sessions and the last good snapshot through upstream failure', async ({ app, request }) => {
  await connect(request, app); const before = await command(request, app);
  const observed = (await app.store.weeklySnapshots(LEAGUE))[0];
  await app.stop('api', 'SIGKILL'); await app.stop('worker', 'SIGKILL');
  app.upstream.fault(`/v1/league/${LEAGUE}`, [503]);
  await app.start('api'); await app.start('worker');
  expect((await request.get(`${app.url}/auth/session`)).status()).toBe(200);
  const retained = await command(request, app);
  expect(retained.sections.snapshot.data.roster.playerIds).toEqual(before.sections.snapshot.data.roster.playerIds);
  expect(retained.sections.snapshot.warnings.join(' ')).toContain('retained snapshot');
  expect((await app.store.weeklySnapshots(LEAGUE))[0]).toEqual(observed);
  app.upstream.clearFaults();
  const recovered = await command(request, app); expect(recovered.sections.scoring.state).toBe('ready');
});

for (const width of [375, 390]) {
  test(`mobile dashboard at ${width}px supports keyboard navigation and WCAG accessibility`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 844 }); await openDashboard(page, app);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(scan.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await page.screenshot({ path: `test-results/dashboard-${width}.png`, fullPage: true });
  });
}


test('the deployment smoke harness passes against the compiled production stack', async ({ app, request }) => {
  await connect(request, app);
  const { smoke } = await import('../smoke.mjs');
  await smoke({ baseUrl: app.url, login: 'owner', password: PASSWORD, leagueId: LEAGUE, week: 8, ignoreHTTPSErrors: true });
});


test('a worker killed during publication recovers after its lease expires without losing the last good week', async ({ app, request }) => {
  await connect(request, app); await app.stop('worker');
  const previous = (await app.store.weeklySnapshots(LEAGUE))[0];
  await app.store.applySync({ freshness: { [`rosters:${LEAGUE}`]: '2020-01-01T00:00:00.000Z' } });
  await app.store.updateLeagueConnection(LEAGUE, { nextAttemptAt: '2020-01-01T00:00:00.000Z' });
  const path = `/v1/league/${LEAGUE}/rosters`; app.upstream.counts.clear();
  const release = app.upstream.hold(path);
  try {
    await app.start('worker'); await eventually(() => app.upstream.counts.get(path) === 1);
    expect(await app.store.lease(`league-sync:publish:${LEAGUE}`)).toBeTruthy();
    await app.stop('worker', 'SIGKILL');
    expect((await app.store.weeklySnapshots(LEAGUE))[0]).toEqual(previous);
    release();
    // Advance only the isolated DB's lease deadlines, so a ten-minute crash lease is deterministic.
    await app.expireLeases(); await app.start('worker');
    await eventually(async () => (await app.store.weeklySnapshots(LEAGUE))[0].id !== previous.id);
    expect((await app.store.weeklySnapshots(LEAGUE)).some(w => w.id === previous.id)).toBe(true);
    expect((await command(request, app)).sections.snapshot.data.roster.playerIds).toEqual(previous.rosters[0].playerIds);
    expect(app.upstream.counts.get(path)).toBe(2);
  } finally { release(); }
});
