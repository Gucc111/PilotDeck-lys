import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const base = process.env.PILOTDECK_TEAM_FIXTURE;
if (!base) throw new Error('Set PILOTDECK_TEAM_FIXTURE to the disposable fixture directory.');
const url = process.env.PILOTDECK_TEAM_UI_URL || 'http://127.0.0.1:5197';
const shots = path.join(base, 'screenshots');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
page.setDefaultTimeout(15000);
await page.addInitScript(() => { localStorage.setItem('userLanguage', 'en'); localStorage.setItem('themeMode', 'dark'); });
const command = async input => { const response = await page.request.post(`${url}/api/team-library`, { data: input }); const result = await response.json(); expect(response.ok(), JSON.stringify(result)).toBeTruthy(); return result; };
const dialog = () => page.getByRole('dialog').last();
const card = name => page.locator('article.team-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
try {
  await page.goto(`${url}/teams`);
  await expect(card('Quarterly report team')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'mobile-dark-library.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await card('Quarterly report team').getByRole('button', { name: 'Details', exact: true }).click();
  await expect(dialog().getByRole('heading', { name: 'Quarterly report team', exact: true })).toBeVisible();
  await expect(dialog().getByRole('button', { name: /^Start (new )?conversation$/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, 'mobile-dark-team-details.png'), fullPage: true });
  expect(await dialog().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: 'Teammates', exact: true }).click();
  await card('Researcher').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog().getByLabel('System prompt', { exact: true })).toHaveValue('Research source material and cite evidence.');
  await page.screenshot({ path: path.join(shots, 'mobile-dark-profile-editor.png'), fullPage: true });
  expect(await dialog().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await dialog().getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Teams', exact: true })).toBeVisible();
  const library = await command({ action: 'library' });
  expect(library).not.toHaveProperty('conversations');
  expect(await fs.readFile(path.join(base, 'model-requests.jsonl'), 'utf8').catch(() => '')).toBe('');
  console.log('PASS real Web: mobile dark configuration library, Team details, profile editing and reload');
} catch (error) { await page.screenshot({ path: path.join(shots, 'responsive-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-10000)); throw error; }
finally { await browser.close(); }
