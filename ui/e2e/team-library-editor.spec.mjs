import { test, expect } from '@playwright/test';

for (const [label, width, height, dark] of [['desktop', 1280, 900, false], ['mobile', 390, 844, true]]) {
  for (const role of ['Leader', 'Teammate']) test(`${label} ${role}: profile model, prompt and grouped tool selection`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const calls = [];
    await page.route('**/api/config', route => route.fulfill({ json: {} }));
    await page.route('**/api/models', route => route.fulfill({ json: { items: [{ id: 'test/large', provider: 'test', model: 'large', displayName: 'Large', available: true }] } }));
    await page.route('**/api/team-library', async route => {
      const cmd = route.request().postDataJSON(); calls.push(cmd);
      const body = cmd.action === 'library' ? { profiles: [], teams: [] } : cmd.action === 'inventory'
        ? { tools: ['read_file', 'write_file', 'edit_file', 'edit_notebook', 'enter_plan_mode', 'exit_plan_mode', 'todo_write', 'bash'].map(name => ({ name, description: `Tool description ${name}` })), skills: [], mcpServers: [] }
        : { id: 'saved', revision: 1, role: cmd.role, config: cmd.config };
      await route.fulfill({ json: body });
    });
    await page.goto('/e2e/fixtures/team-library.html');
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('tab', { name: `${role}s`, exact: true }).click();
    await page.getByRole('button', { name: `New ${role}`, exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    if (role === 'Leader') await expect(dialog.getByLabel('System prompt', { exact: true })).toHaveValue(/You are the Leader/);
    await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('test/large');
    await expect(dialog.getByRole('option', { name: 'Use system default' })).toHaveCount(0);
    await expect(dialog.getByRole('option', { name: 'Plan mode' })).toHaveCount(0);
    const writes = dialog.getByLabel('write_file / edit_file', { exact: true });
    await writes.check();
    await expect(dialog.getByLabel('read_file', { exact: true })).toBeChecked();
    await expect(dialog.getByLabel('read_file', { exact: true })).toBeDisabled();
    await dialog.getByLabel('edit_notebook', { exact: true }).check();
    const plan = dialog.getByLabel('enter_plan_mode / exit_plan_mode', { exact: true });
    const todo = dialog.getByLabel('todo_write', { exact: true });
    await todo.check(); await todo.uncheck();
    await plan.check();
    await expect(todo).toBeChecked(); await expect(todo).toBeDisabled();
    await plan.uncheck();
    await expect(todo).toBeChecked(); await expect(todo).toBeEnabled();
    await todo.uncheck(); await plan.check();
    await expect(dialog.getByText('Optional', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/^Tool description/)).toHaveCount(0);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${label}-tools.png`), fullPage: true });
    await writes.uncheck();
    await expect(dialog.getByLabel('edit_notebook', { exact: true })).not.toBeChecked();
    await expect(dialog.getByLabel('edit_notebook', { exact: true })).toBeDisabled();
    await dialog.getByLabel('read_file', { exact: true }).uncheck();
    await dialog.getByLabel('Display name', { exact: true }).fill(`Release ${role}`);
    await dialog.getByLabel('System prompt', { exact: true }).fill('Track release work.');
    await page.screenshot({ path: testInfo.outputPath(`${label}-prompt.png`), fullPage: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = calls.find(cmd => cmd.action === 'profile_save');
    expect(saved.config.model).toEqual({ mode: 'model', provider: 'test', model: 'large' });
    expect(saved.config.capabilities.tools).toEqual(['enter_plan_mode', 'exit_plan_mode', 'todo_write']);
  });
}
