import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const base = process.env.PILOTDECK_TEAM_FIXTURE;
if (!base) throw new Error('Set PILOTDECK_TEAM_FIXTURE to a disposable fixture directory.');
const url = process.env.PILOTDECK_TEAM_UI_URL || 'http://127.0.0.1:5198';
const reopenOnly = process.env.PILOTDECK_TEAM_REOPEN_ONLY === '1';
const resultFile = path.join(base, 'browser-runtime-result.json');
const shots = path.join(base, 'screenshots'); await fs.mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(20000);
page.on('pageerror', error => console.error('PAGE:', error.message));
await page.addInitScript(() => { localStorage.setItem('userLanguage', 'en'); if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light'); });
const call = async command => { const response = await page.request.post(`${url}/api/team-library`, { data: command }); const data = await response.json(); expect(response.ok(), JSON.stringify(data)).toBeTruthy(); return data; };
async function publicTranscripts() {
  const transcripts = [];
  for (const project of await fs.readdir(path.join(base, 'home', 'projects'))) {
    for (const file of await fs.readdir(path.join(base, 'home', 'projects', project, 'chats')).catch(() => [])) {
      if (file.endsWith('.jsonl')) transcripts.push({ file, path: path.join(base, 'home', 'projects', project, 'chats', file) });
    }
  }
  return transcripts;
}
async function reopenAfterRestart() {
  const prior = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  expect(prior.passed, 'The full workflow must pass before restart verification.').toBe(true);
  expect(typeof prior.currentUrl).toBe('string');
  expect(typeof prior.root).toBe('string');
  const requestLogPath = path.join(base, 'model-requests.jsonl');
  const beforeRequests = await fs.readFile(requestLogPath, 'utf8');
  const beforeTranscripts = await publicTranscripts();
  expect(beforeTranscripts.map(item => item.file)).toEqual(prior.chats);
  expect(beforeTranscripts).toHaveLength(1);
  expect(beforeTranscripts[0].file).toBe(`${prior.root}.jsonl`);
  const beforeTranscript = await fs.readFile(beforeTranscripts[0].path, 'utf8');

  await page.goto(prior.currentUrl);
  await expect(page.getByRole('button', { name: 'Select model or Team' })).toHaveText(/Release review team/);
  expect(page.url()).toBe(prior.currentUrl);
  await expect(page.getByText('Release review complete. The reviewer and tester finished; configuration was confirmed through Leader mediation.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Team updates');
  const view = await call({ action: 'runtime_get', sessionKey: prior.root });
  expect(view.activation.sessionKey).toBe(prior.root);
  expect(view.activation.team.config.displayName).toBe('Release review team');
  expect(view.activation.works).toHaveLength(2);
  expect(view.activation.works.every(work => work.status === 'completed')).toBe(true);
  const peerMessage = view.activation.messages.find(message => message.recipientId !== message.intendedRecipientId);
  expect(peerMessage).toBeTruthy();
  expect(view.activation.messages.some(message => message.relayOf === peerMessage.id)).toBe(true);

  await page.getByRole('button', { name: 'Team details' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Review the release configuration.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Test the release and ask the reviewer about configuration.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Completed', { exact: true })).toHaveCount(2);
  await expect(panel.getByText('Forwarded by Leader to Code reviewer', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'restart-team-results.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Select model or Team' })).toHaveText(/Release review team/);
  await expect(page.getByText('Release review complete. The reviewer and tester finished; configuration was confirmed through Leader mediation.', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'restart-team-chat.png'), fullPage: true });

  const afterTranscripts = await publicTranscripts();
  expect(afterTranscripts).toEqual(beforeTranscripts);
  expect(await fs.readFile(afterTranscripts[0].path, 'utf8')).toBe(beforeTranscript);
  expect(await fs.readFile(requestLogPath, 'utf8')).toBe(beforeRequests);
  await fs.writeFile(path.join(base, 'browser-runtime-restart-result.json'), JSON.stringify({
    passed: true, mode: 'reopen-only', currentUrl: page.url(), root: prior.root,
    works: view.activation.works.length, messages: view.activation.messages.length,
    chats: afterTranscripts.map(item => item.file), transcriptUnchanged: true,
    modelRequestsBefore: beforeRequests.trim().split('\n').filter(Boolean).length,
    additionalModelRequests: 0, screenshots: shots,
  }));
  console.log('PASS restart read-only Web: restored Team identity, 2 completed tasks, relay, unchanged public transcript, no model calls');
}
try {
  if (reopenOnly) {
    await reopenAfterRestart();
  } else {
  await page.goto(url);
  const selector = page.getByRole('button', { name: 'Select model or Team' });
  await expect(selector).toBeEnabled(); await selector.click();
  await page.getByRole('button', { name: /Release review team.*Release lead/ }).click();
  await expect(page.getByRole('dialog', { name: 'Use Release review team' })).toBeVisible();
  await page.getByRole('button', { name: 'Use Team', exact: true }).click();
  await expect(selector).toHaveText(/Release review team/);
  expect(await fs.readFile(path.join(base, 'model-requests.jsonl'), 'utf8').catch(() => '')).toBe('');
  await page.screenshot({ path: path.join(shots, 'desktop-team-selected.png'), fullPage: true });
  const textarea = page.locator('textarea').first();
  await textarea.fill('Review this release with both specialists and confirm the configuration.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Release review complete. The reviewer and tester finished; configuration was confirmed through Leader mediation.', { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(selector).toHaveText(/Release review team/);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Team updates');
  const state = JSON.parse(await fs.readFile(path.join(base, 'home', 'team-runtime', 'state.json'), 'utf8')).state;
  const active = Object.values(state.activations).find(item => item.status === 'active');
  expect(active.works).toHaveLength(2); expect(active.works.every(work => work.status === 'completed')).toBe(true);
  expect(active.messages.some(message => message.recipientId !== message.intendedRecipientId)).toBe(true);
  expect(active.messages.some(message => message.relayOf)).toBe(true);
  const view = await call({ action: 'runtime_get', sessionKey: active.sessionKey });
  expect(view.activation.team.config.displayName).toBe('Release review team');
  await page.getByRole('button', { name: 'Team details' }).click();
  await expect(page.getByRole('dialog').getByText('Code reviewer', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Release tester', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Review the release configuration.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Test the release and ask the reviewer about configuration.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Forwarded by Leader to Code reviewer', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'desktop-team-results.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const currentUrl = page.url(); await page.reload(); await expect(selector).toHaveText(/Release review team/); expect(page.url()).toBe(currentUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('themeMode', 'dark')); await page.reload(); await expect(selector).toHaveText(/Release review team/);
  await page.getByRole('button', { name: 'Team details' }).click();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(shots, 'mobile-dark-team-results.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('themeMode', 'light')); await page.reload(); await expect(selector).toHaveText(/Release review team/);
  await page.screenshot({ path: path.join(shots, 'mobile-light-team-chat.png'), fullPage: true });
  const requests = (await fs.readFile(path.join(base, 'model-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(new Set(requests.map(request => request.model))).toEqual(new Set(['leader', 'reviewer', 'tester']));
  const chats = [];
  for (const project of await fs.readdir(path.join(base, 'home', 'projects'))) {
    for (const file of await fs.readdir(path.join(base, 'home', 'projects', project, 'chats')).catch(() => [])) if (file.endsWith('.jsonl')) chats.push(file);
  }
  expect(chats).toHaveLength(1);
  await fs.writeFile(path.join(base, 'browser-runtime-result.json'), JSON.stringify({ passed: true, currentUrl, root: active.sessionKey, works: active.works.length, messages: active.messages.length, chats, screenshots: shots }));
  console.log('PASS real Web: composer Team selection, no model before send, async delegation, mediated messaging, final Leader answer, one main chat, refresh, mobile themes');
  }
} catch (error) { await page.screenshot({ path: path.join(shots, reopenOnly ? 'runtime-restart-failure.png' : 'runtime-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-14000)); throw error; }
finally { await browser.close(); }
