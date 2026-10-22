import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.PILOTDECK_TEAM_FIXTURE;
if (!base) throw new Error('Set PILOTDECK_TEAM_FIXTURE to the disposable fixture directory.');
const url = process.env.PILOTDECK_TEAM_UI_URL || 'http://127.0.0.1:5197';
const { projects } = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
const shots = path.join(base, 'screenshots'); await fs.mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15000);
await page.addInitScript(() => { localStorage.setItem('userLanguage', 'en'); localStorage.setItem('themeMode', 'light'); });
const call = async command => { const response = await page.request.post(`${url}/api/team-library`, { data: command }); const data = await response.json(); expect(response.ok(), JSON.stringify(data)).toBeTruthy(); return data; };
const card = name => page.locator('article.team-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const dialog = () => page.getByRole('dialog').last();
const save = async () => { await dialog().getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0); };

try {
  await page.goto(`${url}/teams`); await expect(page.getByRole('tab', { name: 'Leaders', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Leaders', exact: true }).click();
  await page.getByRole('button', { name: 'New Leader', exact: true }).first().click();
  await dialog().getByLabel('Display name', { exact: true }).fill('Research lead');
  await dialog().getByLabel('System prompt', { exact: true }).fill('Lead the report. Ask for evidence and distinguish facts from assumptions.');
  await dialog().getByLabel('Model', { exact: true }).selectOption('test/leader');
  await dialog().getByRole('checkbox', { name: 'read_file', exact: true }).check();
  await save(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Teammates', exact: true }).click();
  await page.getByRole('button', { name: 'New Teammate', exact: true }).first().click();
  await dialog().getByLabel('Display name', { exact: true }).fill('Researcher');
  await dialog().getByLabel('System prompt', { exact: true }).fill('Research source material and cite evidence.');
  await dialog().getByLabel('Model', { exact: true }).selectOption('test/researcher');
  await dialog().getByLabel('Workspace', { exact: true }).selectOption('fixed');
  await dialog().getByLabel('Use a fixed project', { exact: true }).selectOption(projects[1]);
  await save(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).first().click();
  await dialog().getByLabel('Display name', { exact: true }).fill('Quarterly report team');
  const before = await call({ action: 'library' }); const leader = before.profiles.find(p => p.role === 'leader');
  await dialog().getByLabel('Leader', { exact: true }).selectOption(leader.id);
  await dialog().getByRole('checkbox', { name: 'Researcher', exact: true }).check();
  await dialog().getByLabel('Default workspace', { exact: true }).selectOption(projects[0]);
  await save(); await expect(dialog().getByRole('heading', { name: 'Quarterly report team', exact: true })).toBeVisible();
  let state = await call({ action: 'library' }); expect(state).not.toHaveProperty('conversations'); expect(state.teams).toHaveLength(1);
  await page.screenshot({ path: path.join(shots, 'desktop-team-saved.png'), fullPage: true });
  await dialog().getByRole('button', { name: 'Copy and edit (Fork)', exact: true }).click();
  await dialog().getByLabel('Display name', { exact: true }).fill('Competitor weekly team');
  await dialog().getByRole('button', { name: 'Copy and edit (Fork)', exact: true }).click();
  await expect(dialog().getByRole('heading', { name: 'Edit Team', exact: true })).toBeVisible();
  await save(); await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  state = await call({ action: 'library' }); expect(state.teams).toHaveLength(2); expect(state.profiles).toHaveLength(2);
  await page.getByRole('tab', { name: 'Teammates', exact: true }).click();
  await card('Researcher').getByRole('button', { name: 'Copy and edit (Fork)', exact: true }).click();
  await dialog().getByLabel('Display name', { exact: true }).fill('Competitor researcher');
  await dialog().getByRole('button', { name: 'Copy and edit (Fork)', exact: true }).click();
  await expect(dialog().getByRole('heading', { name: 'Edit Teammate', exact: true })).toBeVisible();
  await dialog().getByLabel('System prompt', { exact: true }).fill('Track only named competitors and cite source dates.');
  await save(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Leaders', exact: true }).click();
  await card('Research lead').getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog().getByLabel('System prompt', { exact: true }).fill('Lead the report. Always separate verified facts from assumptions.');
  await save(); await expect(page.getByRole('dialog')).toHaveCount(0);
  state = await call({ action: 'library' }); expect(state.teams.every(team => team.leader.revision === 1)).toBeTruthy();
  await page.getByRole('tab', { name: 'Teams', exact: true }).click();
  await card('Quarterly report team').getByRole('button', { name: 'Details', exact: true }).click();
  await expect(dialog().getByText('Update available', { exact: true })).toBeVisible();
  await dialog().getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog().getByRole('button', { name: 'Review update', exact: true }).click();
  await expect(dialog().getByRole('heading', { name: 'Profile update', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'desktop-explicit-update.png'), fullPage: true });
  await dialog().getByRole('button', { name: 'Use latest', exact: true }).click(); await save();
  state = await call({ action: 'library' });
  expect(state.teams.find(t => t.config.displayName === 'Quarterly report team').leader.revision).toBe(2);
  expect(state.teams.find(t => t.config.displayName === 'Competitor weekly team').leader.revision).toBe(1);
  await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Start (new )?conversation$/ })).toHaveCount(0);
  await page.reload();
  await expect(card('Quarterly report team')).toBeVisible();
  await expect(card('Competitor weekly team')).toBeVisible();
  for (const action of ['start', 'probe', 'conversation_get']) {
    const rejected = await page.request.post(`${url}/api/team-library`, { data: { action } });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error.code).toBe('TEAM_INVALID_INPUT');
  }
  const finalState = await call({ action: 'library' });
  expect(finalState).not.toHaveProperty('conversations');
  expect(finalState.teams).toHaveLength(2);
  const requestLog = await fs.readFile(path.join(base, 'model-requests.jsonl'), 'utf8').catch(() => '');
  expect(requestLog).toBe('');
  for (const project of await fs.readdir(path.join(base, 'home', 'projects'))) {
    const chats = await fs.readdir(path.join(base, 'home', 'projects', project, 'chats')).catch(() => []);
    expect(chats.filter(name => name.endsWith('.jsonl'))).toHaveLength(0);
  }
  console.log('PASS real Web: profiles, Teams, both forks, explicit updates, reload, no conversation entry or chat/model creation');
  await fs.writeFile(path.join(base, 'browser-result.json'), JSON.stringify({ passed: true, teams: finalState.teams.length, screenshots: shots }));
} catch (error) { await page.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-10000)); throw error; }
finally { await browser.close(); }
