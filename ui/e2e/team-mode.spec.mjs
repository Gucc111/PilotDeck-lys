import { test, expect } from '@playwright/test';
const profile = (id, role, displayName) => ({ id, revision: 1, role, config: { displayName, model: { mode: 'model', provider: 'test', model: 'role-model' }, workspace: { mode: 'team' } } });
const leader = profile('leader', 'leader', 'Release lead');
const tester = profile('tester', 'teammate', 'Tester');
const team = { id: 'team', revision: 1, config: { displayName: 'Release review', defaultProjectKey: '/work' }, leader, teammates: [tester] };
const participants = [leader, tester].map(item => ({ id: item.id, role: item.role, profile: item, projectKey: '/work', model: item.config.model }));
async function mockApi(page, options = {}) {
  let activation = options.activation || null;
  const calls = [];
  await page.route('**/api/team-library', async route => {
    const command = route.request().postDataJSON(); calls.push(command);
    let body;
    if (command.action === 'library') body = { profiles: [leader, tester], teams: [team] };
    else if (command.action === 'runtime_probe') body = { team, projectKey: '/work', participants, compatible: !options.block, fingerprint: 'probe', issues: options.block ? [{ severity: 'error', code: 'unavailable', message: 'Unavailable capability: ' + 'long-service-detail/'.repeat(80) }] : [] };
    else if (command.action === 'runtime_select') body = { activation: activation = { id: 'activation', sessionKey: command.sessionKey, team, projectKey: '/work', status: 'active', participants, works: [], messages: [], notifications: [] } };
    else if (command.action === 'runtime_stop') body = { activation: activation = { ...activation, status: 'stopped', works: activation.works.map(work => ({ ...work, status: 'stopped' })) } };
    else body = { activation };
    await route.fulfill({ json: body });
  });
  return calls;
}
for (const [label, width, height, dark] of [['desktop-light', 1100, 800, false], ['mobile-dark', 390, 844, true]]) {
  test(`${label}: Team menu, current conversation, reload and panel`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const calls = await mockApi(page);
    await page.goto('/e2e/fixtures/team-mode.html?session=web:s_existing');
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    const chooser = page.getByRole('button', { name: 'Select model or Team' });
    await expect(chooser).toBeEnabled(); await chooser.click();
    await expect(page.getByRole('group', { name: 'Teams' })).toBeVisible();
    await page.getByRole('button', { name: /Release review.*Release lead/ }).click();
    await expect(page.getByRole('dialog', { name: 'Use Release review' })).toBeVisible();
    await page.getByRole('button', { name: 'Use Team', exact: true }).click();
    await expect(chooser).toHaveText(/Release review/);
    await expect(page.getByTestId('chat-history')).toHaveText('Existing conversation history stays here.');
    expect(page.url()).toContain('session=web:s_existing');
    const selection = calls.find(call => call.action === 'runtime_select');
    expect(selection.storageProjectKey).toBe('/general'); expect(selection.projectKey).toBe('/work');
    await page.reload();
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(chooser).toHaveText(/Release review/);
    await page.getByRole('button', { name: 'Team details' }).click();
    await expect(page.getByRole('dialog').getByText('Tester', { exact: true })).toBeVisible();
    expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${label}-panel.png`), fullPage: true });
  });
}
test('blank selection is model free and long compatibility errors fit mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mockApi(page, { block: true });
  await page.goto('/e2e/fixtures/team-mode.html');
  await page.getByRole('button', { name: 'Select model or Team' }).click();
  await page.getByRole('button', { name: /Release review.*Release lead/ }).click();
  await expect(page.getByRole('button', { name: 'Use Team', exact: true })).toBeDisabled();
  await expect(page.getByText(/Unavailable capability:/)).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(calls.some(call => call.action === 'runtime_select')).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('mobile-long-error.png'), fullPage: true });
});
test('pending member work keeps stop available after Leader finishes and prevents mode switching', async ({ page }) => {
  const calls = await mockApi(page, { activation: { id: 'activation', sessionKey: 'web:s_existing', team, projectKey: '/work', status: 'active', participants, works: [{ id: 'work', participantId: 'tester', task: 'Test release', status: 'waiting_approval' }], messages: [{ id: 'msg', senderId: 'tester', recipientId: 'leader', intendedRecipientId: 'tester', text: 'Clarify acceptance criteria', status: 'queued' }], notifications: [] } });
  await page.goto('/e2e/fixtures/team-mode.html?session=web:s_existing');
  await expect(page.getByRole('button', { name: 'Select model or Team' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message' }).fill('');
  await page.getByRole('button', { name: /Stop/i }).click();
  await expect(page.getByRole('button', { name: 'Select model or Team' })).toBeEnabled();
  expect(calls.some(call => call.action === 'runtime_stop')).toBe(true);
});
