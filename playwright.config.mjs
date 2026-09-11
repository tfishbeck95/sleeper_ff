import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60_000, expect: { timeout: 10_000 },
  fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/e2e.xml' }]],
  use: { ignoreHTTPSErrors: true, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
});
