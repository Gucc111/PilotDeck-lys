import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Actual product React components, HTTP and WebSocket test doubles. These
// checks do not claim Gateway persistence, tool effects, or real-model E2E.
const report = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/testing/reports/2026-10-28-team-human-interactions');
const root = 'web:fixture-root', activationId = 'fixture-activation', stopVersion = 2;
const profile = (id, role, displayName) => ({ id, revision: 1, role, config: { displayName, model: { mode: 'model', provider: 'fixture-provider', model: 'fixture-model' }, workspace: { mode: 'team' }, capabilities: { tools: ['write_file'], skills: [], mcpServers: [] } } });
const leader = profile('leader', 'leader', 'Leader must stay outside interaction cards');
const reviewer = profile('reviewer', 'teammate', 'Code reviewer');
const tester = profile('tester', 'teammate', 'Release tester');
const team = { id: 'team', revision: 1, config: { displayName: 'Controlled release team', defaultProjectKey: '/fixture/project' }, leader, teammates: [reviewer, tester] };
const participants = [leader, reviewer, tester].map(item => ({ id: item.id, role: item.role, profile: item, projectKey: '/fixture/project', model: item.config.model, capabilities: item.config.capabilities }));
const createdAt = '2026-10-28T09:00:00.000Z';
const longPlan = '# Release verification plan\n\n' + Array.from({ length: 28 }, (_, i) => `${i + 1}. Verify release artifact ${i + 1} and record the result. \`artifact-${'long-name-'.repeat(9)}${i}\``).join('\n\n');
function interaction(id, participantId, kind, request, toolName) {
  return { id, requestId: `request-${id}`, activationId, sessionKey: root, stopVersion, participantId, participantDisplayName: participants.find(item => item.id === participantId).profile.config.displayName, kind, toolName, request, status: 'pending', createdAt };
}
function initialInteractions() {
  return [
    interaction('reviewer-permission', 'reviewer', 'tool_permission', { type: 'permission_request', payload: { path: '/fixture/project/reviewer.txt', content: 'reviewed' } }, 'write_file'),
    interaction('tester-permission', 'tester', 'tool_permission', { type: 'permission_request', payload: { command: 'printf test-only' } }, 'bash'),
    interaction('reviewer-question', 'reviewer', 'user_question', { type: 'elicitation_request', questions: [{ question: 'Which release checks should run?', header: 'Checks', multiSelect: true, options: [{ label: 'Security', description: 'Inspect authorization' }, { label: 'Regression', description: 'Verify existing behavior' }] }] }, 'ask_user_question'),
    interaction('tester-question', 'tester', 'user_question', { type: 'elicitation_request', questions: [{ question: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Production' }] }] }, 'ask_user_question'),
    interaction('reviewer-plan', 'reviewer', 'plan_approval', { type: 'elicitation_request', questions: [], metadata: { plan: longPlan } }, 'exit_plan_mode'),
    interaction('tester-plan', 'tester', 'plan_approval', { type: 'elicitation_request', questions: [], metadata: { plan: '# Tester plan\n\nRun the targeted checks.' } }, 'exit_plan_mode'),
    { ...interaction('expired-plan', 'tester', 'plan_approval', { input: { plan: '# Expired plan\n\nNo execution is possible.' } }, 'exit_plan_mode'), status: 'expired', resolvedAt: createdAt, error: 'Execution connection expired after restart.' },
  ];
}
async function mockApi(page, { failResponse = false } = {}) {
  const ledger = initialInteractions(), calls = [];
  const activation = { id: activationId, sessionKey: root, team, projectKey: '/fixture/project', participants, stopVersion, status: 'active', createdAt, updatedAt: createdAt, interactions: ledger, works: [], messages: [], notifications: [] };
  const messages = [{ id: 'assistant-history', role: 'assistant', turnId: 'turn-1', createdAt, content: [{ type: 'text', text: 'Saved teammate history.' }] }];
  let revision = 1, streaming = false;
  await page.route('**/api/team-library', async route => {
    const command = route.request().postDataJSON(); calls.push(command);
    let body;
    if (command.action === 'library') body = { profiles: [leader, reviewer, tester], teams: [team] };
    else if (command.action === 'runtime_get') body = { activation, history: [] };
    else if (['runtime_interaction_respond', 'team_interaction_respond'].includes(command.action)) {
      if (failResponse) return route.fulfill({ status: 503, json: { error: 'Controlled response failure: ' + 'very-long-service-error/'.repeat(90) } });
      const item = ledger.find(item => item.id === command.interactionId);
      expect(command).toMatchObject({ sessionKey: root, activationId, stopVersion, participantId: item.participantId, requestId: item.requestId, kind: item.kind });
      item.status = ({ allow: 'allowed', deny: 'denied', approve: 'approved', decline: 'declined', cancel: 'cancelled' })[command.decision] || 'answered';
      item.resolution = command.answer ?? { decision: command.decision, reason: command.reason };
      item.resolvedAt = '2026-10-28T09:01:00.000Z';
      body = { interaction: item, delivered: true };
    } else if (['runtime_participant_messages', 'team_participant_messages'].includes(command.action)) {
      expect(command).toMatchObject({ sessionKey: root, activationId, stopVersion, participantId: 'reviewer' });
      body = { sessionKey: root, activationId, participantId: command.participantId, stopVersion, streamEpoch: 'fixture-epoch', revision, messages, streaming };
    } else throw new Error(`Unexpected fixture command ${command.action}`);
    await route.fulfill({ json: body });
  });
  return { ledger, calls, activation, messages, setStream(value) { streaming = value; revision += 1; }, get revision() { return revision; } };
}
async function setup(page, language = 'en', dark = false, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await page.addInitScript(({ language, dark }) => { localStorage.setItem('userLanguage', language); localStorage.setItem('themeMode', dark ? 'dark' : 'light'); }, { language, dark });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  return errors;
}
async function screenshot(page, name) { await fs.mkdir(path.join(report, 'screenshots'), { recursive: true }); await page.screenshot({ path: path.join(report, 'screenshots', name), fullPage: true }); }
async function openPanel(page) { await page.getByRole('button', { name: 'Team interactions', exact: true }).click(); return page.getByRole('dialog', { name: /Team interactions/ }); }
const card = (page, name) => page.locator('.team-interaction-teammate-card').filter({ has: page.getByText(name, { exact: true }) });
async function openRow(page, name, tool) { await card(page, name).locator('.team-interaction-entry-button').filter({ hasText: tool }).first().click(); return page.locator('.team-interaction-modal'); }
async function closeInteraction(page) { await page.locator('.team-interaction-modal').getByRole('button', { name: 'Close', exact: true }).click(); }

for (const options of [{ label: 'desktop-light-en', language: 'en', dark: false, width: 1280 }, { label: 'mobile-dark-zh', language: 'zh-CN', dark: true, width: 390 }, { label: 'desktop-dark-en', language: 'en', dark: true, width: 1280 }, { label: 'mobile-light-zh', language: 'zh-CN', dark: false, width: 390 }]) {
  test(`${options.label}: two entries, per-member sections, long plan and read-only history`, async ({ page }) => {
    const errors = await setup(page, options.language, options.dark, options.width); await mockApi(page);
    await page.goto('/e2e/fixtures/team-interactions.html');
    const interactionsLabel = options.language === 'en' ? 'Team interactions' : '团队交互';
    const detailsLabel = options.language === 'en' ? 'Team details' : '团队详情';
    await expect(page.getByRole('button', { name: detailsLabel, exact: true })).toBeVisible();
    const entry = page.getByRole('button', { name: interactionsLabel, exact: true }); await expect(entry).toContainText('6'); await entry.click();
    await expect(page.locator('.team-interaction-teammate-card')).toHaveCount(2);
    await expect(page.locator('.team-interaction-section')).toHaveCount(6);
    const body = page.locator('.team-mode-dialog .team-mode-body').first();
    await expect(body).not.toContainText('fixture-provider'); await expect(body).not.toContainText('/fixture/project'); await expect(body).not.toContainText(leader.config.displayName);
    await expect(page.getByTestId('leader-chat')).toHaveText('Leader conversation remains separate.');
    await screenshot(page, `${options.label}-panel.png`);
    await openRow(page, 'Code reviewer', 'exit_plan_mode');
    const modal = page.locator('.team-interaction-modal'); await expect(modal).toContainText('Release verification plan');
    expect(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await screenshot(page, `${options.label}-long-plan.png`);
    await modal.getByRole('button', { name: options.language === 'en' ? 'Close' : '关闭', exact: true }).click();
    await card(page, 'Release tester').locator('.is-handled .team-interaction-entry-button').click();
    await expect(page.locator('.team-interaction-modal')).toContainText('No execution is possible.');
    await expect(page.locator('.team-interaction-modal button')).toHaveCount(1);
    await screenshot(page, `${options.label}-expired-history.png`);
    expect(errors).toEqual([]);
  });
}

test('permission, multi-select answer/cancel, Plan approve/decline keep handled history and owner fields', async ({ page }) => {
  const errors = await setup(page); const state = await mockApi(page);
  await page.goto('/e2e/fixtures/team-interactions.html'); await openPanel(page);
  await openRow(page, 'Code reviewer', 'write_file'); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.locator('.team-interaction-modal')).toContainText('Allowed'); await closeInteraction(page);
  await openRow(page, 'Release tester', 'bash'); await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(page.locator('.team-interaction-modal')).toContainText('Denied'); await closeInteraction(page);
  await openRow(page, 'Code reviewer', 'ask_user_question');
  await page.getByRole('button', { name: /Security/ }).click(); await page.getByRole('button', { name: /Regression/ }).click();
  await page.getByRole('button', { name: /^Submit/ }).click(); await expect(page.locator('.team-interaction-modal')).toContainText('Answered'); await closeInteraction(page);
  await openRow(page, 'Release tester', 'ask_user_question'); await page.getByRole('button', { name: /^Skip/ }).click();
  await expect(page.locator('.team-interaction-modal')).toContainText('Cancelled'); await closeInteraction(page);
  await openRow(page, 'Code reviewer', 'exit_plan_mode'); await page.getByRole('button', { name: 'Execute Plan', exact: true }).click();
  await expect(page.locator('.team-interaction-modal')).toContainText('Execution approved'); await closeInteraction(page);
  await openRow(page, 'Release tester', 'exit_plan_mode'); await page.getByRole('button', { name: 'Continue Discussion', exact: true }).click();
  await expect(page.locator('.team-interaction-modal')).toContainText('Execution declined'); await closeInteraction(page);
  await page.getByRole('button', { name: 'Handled', exact: true }).click(); await expect(page.locator('.is-handled')).toHaveCount(7);
  await screenshot(page, 'desktop-handled-history.png'); await page.reload();
  await expect(page.getByRole('button', { name: 'Handled', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.is-handled')).toHaveCount(7);
  expect(state.ledger.map(item => item.status)).toEqual(['allowed', 'denied', 'answered', 'cancelled', 'approved', 'declined', 'expired']);
  const responses = state.calls.filter(call => call.action.endsWith('interaction_respond'));
  expect(responses).toHaveLength(6); expect(responses[2].answer).toEqual({ type: 'answered', answers: { 'Which release checks should run?': 'Security, Regression' } });
  expect(errors).toEqual([]);
});

test('failed response stays pending with long readable error; Escape closes without answering', async ({ page }) => {
  const errors = await setup(page, 'en', false, 390); const state = await mockApi(page, { failResponse: true });
  await page.goto('/e2e/fixtures/team-interactions.html'); await openPanel(page);
  await openRow(page, 'Code reviewer', 'write_file'); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  const modal = page.locator('.team-interaction-modal'); await expect(modal.getByRole('alert')).toContainText('Controlled response failure');
  expect(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled(); await screenshot(page, 'mobile-light-long-response-error.png');
  await closeInteraction(page); await openRow(page, 'Code reviewer', 'ask_user_question'); await page.keyboard.press('Escape');
  await expect(page.locator('.team-interaction-modal')).toHaveCount(0);
  expect(state.ledger.filter(item => item.status === 'pending')).toHaveLength(6);
  expect(state.calls.filter(call => call.action.endsWith('interaction_respond'))).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('read-only route restores history, streams without refetch, ignores stale frames, reconnects and returns to filter', async ({ page }) => {
  const errors = await setup(page); const state = await mockApi(page);
  await page.goto('/e2e/fixtures/team-interactions.html'); await openPanel(page);
  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await card(page, 'Code reviewer').getByRole('button', { name: 'View chat', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/web%3Afixture-root\/fixture-activation\/teammate\/reviewer$/);
  await expect(page.getByText('Saved teammate history.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__teamFixtureSent)).toContainEqual({ type: 'watch-session', sessionId: root });
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Send|Stop|Rename|Fork|Edit|Select model)/ })).toHaveCount(0);
  const readsBefore = state.calls.filter(call => call.action.endsWith('participant_messages')).length;
  const streamed = { id: 'stream-message', role: 'assistant', turnId: 'turn-2', createdAt: '2026-10-28T09:02:00.000Z', content: [{ type: 'text', text: 'Streaming teammate output before persistence.' }], isStreaming: true };
  const frame = { type: 'team-participant-message', sessionKey: root, activationId, participantId: 'reviewer', stopVersion, streamEpoch: 'fixture-epoch', revision: 2, messages: [streamed], streaming: true };
  await page.evaluate(frame => window.__teamFixtureEmit(frame), frame);
  await expect(page.getByText('Streaming teammate output before persistence.', { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.action.endsWith('participant_messages'))).toHaveLength(readsBefore);
  await page.evaluate(frame => window.__teamFixtureEmit(frame), { ...frame, activationId: 'old-activation', revision: 3, messages: [{ ...streamed, content: [{ type: 'text', text: 'STALE CONTENT MUST BE HIDDEN' }] }] });
  await page.evaluate(frame => window.__teamFixtureEmit(frame), { ...frame, stopVersion: stopVersion - 1, revision: 4, messages: [{ ...streamed, content: [{ type: 'text', text: 'STALE CONTENT MUST BE HIDDEN' }] }] });
  await expect(page.getByText('STALE CONTENT MUST BE HIDDEN', { exact: true })).toHaveCount(0);
  await screenshot(page, 'desktop-readonly-stream.png');
  state.messages.push({ ...streamed, isStreaming: false }); state.setStream(false);
  await page.evaluate(() => window.__teamFixtureEmit({ type: 'websocket-reconnected' }));
  await expect.poll(() => state.calls.filter(call => call.action.endsWith('participant_messages')).length).toBeGreaterThan(readsBefore);
  await expect(page.getByText('Streaming teammate output before persistence.', { exact: true })).toHaveCount(1);
  const directUrl = page.url(); await page.reload(); await expect(page.getByText('Saved teammate history.', { exact: true })).toBeVisible();
  await expect(page.getByText('Streaming teammate output before persistence.', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: /Back to Team|返回团队/ }).click(); await expect(page.getByRole('button', { name: 'Pending', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__teamFixtureSent)).toContainEqual({ type: 'unwatch-session', sessionId: root });
  await page.goto(directUrl); await expect(page.getByText('Saved teammate history.', { exact: true })).toBeVisible();
  await screenshot(page, 'desktop-readonly-direct-url.png');
  expect(state.calls.every(call => ['library', 'runtime_get', 'runtime_participant_messages', 'team_participant_messages'].includes(call.action))).toBe(true);
  expect(errors).toEqual([]);
});
