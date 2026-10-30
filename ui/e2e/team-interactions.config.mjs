import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.', testMatch: ['team-interactions.spec.mjs'], workers: 1,
  timeout: 45000, outputDir: '/tmp/pilotdeck-team-interactions-playwright',
  reporter: [['list'], ['json', { outputFile: path.join(uiRoot, '../docs/testing/reports/2026-10-29-team-communication-controlled-ui/browser-results.json') }]],
  use: { baseURL: 'http://127.0.0.1:5188', screenshot: 'only-on-failure' },
  webServer: { command: 'node e2e/team-interactions.server.mjs', cwd: uiRoot,
    url: 'http://127.0.0.1:5188/e2e/fixtures/team-interactions.html', reuseExistingServer: false },
});
