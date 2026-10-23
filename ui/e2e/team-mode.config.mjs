import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.', testMatch: ['team-mode.spec.mjs'], outputDir: '/tmp/pilotdeck-team-mode-playwright', workers: 1,
  use: { channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || undefined, baseURL: 'http://127.0.0.1:5186', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5186 --strictPort', cwd: uiRoot,
    url: 'http://127.0.0.1:5186/e2e/fixtures/team-mode.html', reuseExistingServer: false },
});
