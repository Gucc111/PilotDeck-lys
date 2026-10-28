import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.', testMatch: ['team-library-editor.spec.mjs'], outputDir: '/tmp/pilotdeck-team-library-editor', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5198', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort', cwd: uiRoot,
    url: 'http://127.0.0.1:5198/e2e/fixtures/team-library.html', reuseExistingServer: true },
});
