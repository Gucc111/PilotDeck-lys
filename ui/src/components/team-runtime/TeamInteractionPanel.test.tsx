// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
let i18n: Awaited<ReturnType<typeof createTestI18n>>;
import TeamInteractionPanel from './TeamInteractionPanel';
import type { TeamModeState } from './useTeamMode';
import type { TeamHumanInteraction } from './teamInteractionTypes';
import { interactionRequestInput } from './teamInteractionTypes';

const interaction: TeamHumanInteraction = {
  id: 'interaction-1', requestId: 'request-1', activationId: 'activation-1', sessionKey: 'web:s_team', stopVersion: 0,
  participantId: 'teammate-1', participantDisplayName: 'Reviewer', kind: 'tool_permission', toolName: 'write_file',
  request: { input: { path: 'report.md' } }, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
};
const question: TeamHumanInteraction = { ...interaction, kind: 'user_question', toolName: 'ask_user_question', request: { questions: [{ question: 'Which checks?', multiSelect: true, options: [{ label: 'Tests' }, { label: 'Types' }] }] } };
const plan: TeamHumanInteraction = { ...interaction, kind: 'plan_approval', toolName: 'exit_plan_mode', request: { metadata: { plan: '# Release checklist\n\nRun the tests.' } } };
beforeEach(async () => { sessionStorage.clear(); i18n = await createTestI18n('zh-CN'); });
afterEach(cleanup);
function makeMode(overrides: Partial<TeamModeState> = {}): TeamModeState {
  return {
    activation: { id: 'activation-1', sessionKey: 'web:s_team', projectKey: '/work', team: {} as any, participants: [{ id: 'teammate-1', role: 'teammate', profile: { config: { displayName: 'Reviewer' } } } as any], probeFingerprint: '', status: 'active', createdAt: '', updatedAt: '', works: [], messages: [], notifications: [], interactions: [interaction], automaticWakeups: 0, stopVersion: 0 },
    interactions: [interaction], respondInteraction: vi.fn().mockResolvedValue(undefined), deleteMessage: vi.fn().mockResolvedValue(undefined),
    selectedTeam: { config: { displayName: 'Team' } } as any, history: [], panelOpen: false, setPanelOpen: vi.fn(), refresh: vi.fn(), ...overrides,
  } as unknown as TeamModeState;
}
function show(mode = makeMode(), onClose = vi.fn(), onViewChat = vi.fn()) {
  return render(<I18nextProvider i18n={i18n}><TeamInteractionPanel mode={mode} onClose={onClose} onViewChat={onViewChat} /></I18nextProvider>);
}
function openRequest(name = /write_file/) { fireEvent.click(screen.getByRole('button', { name })); }
function detail() { return within(screen.getAllByRole('dialog').at(-1)!); }

describe('TeamInteractionPanel', () => {
  it('shows the Leader inbox without approval sections and keeps messages with their recipients', async () => {
    const mode = makeMode();
    mode.activation!.participants.unshift({ id: 'leader', role: 'leader', profile: { config: { displayName: 'Leader name' } } } as any);
    mode.activation!.messages = [
      { id: 'received', senderId: 'teammate-1', recipientId: 'leader', intendedRecipientId: 'leader', text: 'Should I keep the old API?', status: 'queued', stopVersion: 0, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'notice', senderId: 'system', recipientId: 'teammate-1', intendedRecipientId: 'teammate-1', text: 'Round ended', kind: 'turn_ended', status: 'invalidated', stopVersion: 0, createdAt: '2026-01-01T00:00:00Z' },
    ];
    show(mode);
    const leaderCard = screen.getByText('Leader name').closest('article')!;
    expect(within(leaderCard).getByText('Should I keep the old API?')).toBeTruthy();
    expect(within(leaderCard).queryByRole('button', { name: /工具调用权限询问/ })).toBeNull();
    expect(within(leaderCard).queryByText('Round ended')).toBeNull();
    expect(screen.getAllByRole('button', { name: '删除消息' })).toHaveLength(1);
    expect(screen.getByText('已失效，不会发送')).toBeTruthy();
    fireEvent.click(within(leaderCard).getByRole('button', { name: '删除消息' }));
    await waitFor(() => expect(mode.deleteMessage).toHaveBeenCalledWith(mode.activation!.messages[0]));
  });
  it('retains a message and reports a failed delete', async () => {
    const mode = makeMode({ deleteMessage: vi.fn().mockRejectedValue(new Error('Already sent in a model request')) });
    mode.activation!.messages = [{ id: 'message', senderId: 'leader', recipientId: 'teammate-1', intendedRecipientId: 'teammate-1', text: 'Keep both APIs', status: 'consumed', stopVersion: 0, createdAt: '2026-01-01T00:00:00Z' }];
    show(mode); fireEvent.click(screen.getByRole('button', { name: '删除消息' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Already sent'));
    expect(screen.getByText('Keep both APIs')).toBeTruthy();
  });
  it('projects gateway envelopes into ordinary renderer snapshots', () => {
    expect(interactionRequestInput({ ...interaction, request: { type: 'permission_request', payload: { path: 'report.md' } } })).toEqual({ path: 'report.md' });
    expect(interactionRequestInput(plan)).toEqual({ plan: '# Release checklist\n\nRun the tests.' });
  });
  it('opens an ordinary permission card in a modal without persistent grant controls', async () => {
    const mode = makeMode(); show(mode);
    expect(screen.queryByText('report.md')).toBeNull();
    openRequest();
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    expect(detail().queryByRole('button', { name: i18n.t('permissionBanner.allowRemember', { ns: 'chat' }) })).toBeNull();
    fireEvent.click(detail().getByRole('button', { name: '仅允许一次' }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledWith(interaction, { decision: 'allow', reason: undefined }));
  });
  it('disables every response control while a response is in flight and consumes one click', async () => {
    let complete!: () => void;
    const mode = makeMode({ respondInteraction: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })) }); show(mode); openRequest();
    const allow = detail().getByRole('button', { name: '仅允许一次' }); fireEvent.click(allow); fireEvent.click(allow);
    expect(mode.respondInteraction).toHaveBeenCalledTimes(1);
    for (const button of detail().getAllByRole('button')) expect(button.matches(':disabled')).toBe(true);
    await act(async () => complete());
  });
  it('keeps failure pending and supports retry', async () => {
    const mode = makeMode({ respondInteraction: vi.fn().mockRejectedValueOnce(new Error('request disconnected')).mockResolvedValue(undefined) }); show(mode); openRequest();
    fireEvent.click(detail().getByRole('button', { name: '仅允许一次' }));
    await waitFor(() => expect(detail().getByRole('alert').textContent).toContain('request disconnected'));
    fireEvent.click(detail().getByRole('button', { name: '仅允许一次' }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledTimes(2));
  });
  it.each([question, plan])('renders handled $kind as read-only request and resolution', item => {
    const handled = { ...item, status: 'declined' as const, resolution: { reason: 'Please revise the scope' }, resolvedAt: '2026-01-01T00:01:00Z' };
    show(makeMode({ interactions: [handled] })); openRequest(new RegExp(item.toolName!));
    expect(detail().getByText(/Please revise the scope/)).toBeTruthy();
    expect(detail().queryByRole('textbox')).toBeNull();
    expect(detail().getAllByRole('button')).toHaveLength(1); // close only
  });
  it('sends all selected question options; Escape only closes the modal', async () => {
    const onClose = vi.fn(); const mode = makeMode({ interactions: [question] }); show(mode, onClose); openRequest(/ask_user_question/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mode.respondInteraction).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(screen.getAllByRole('dialog')).toHaveLength(1);
    openRequest(/ask_user_question/);
    fireEvent.click(detail().getByText('Tests')); fireEvent.click(detail().getByText('Types'));
    fireEvent.click(detail().getByRole('button', { name: new RegExp(i18n.t('uiText.submit', { ns: 'common' })) }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledWith(question, { answer: { type: 'answered', answers: { 'Which checks?': 'Tests, Types' } }, reason: undefined }));
  });
  it('maps question skip to explicit cancellation', async () => {
    const mode = makeMode({ interactions: [question] }); show(mode); openRequest(/ask_user_question/);
    fireEvent.click(detail().getByRole('button', { name: new RegExp(i18n.t('uiText.skip', { ns: 'common' })) }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledWith(question, { decision: 'cancel', reason: undefined }));
  });
  it('preserves Plan rejection notes with the ordinary Plan card', async () => {
    const mode = makeMode({ interactions: [plan] }); show(mode); openRequest(/exit_plan_mode/);
    expect(detail().getByText('Release checklist')).toBeTruthy();
    fireEvent.change(detail().getByRole('textbox'), { target: { value: 'Add rollback checks' } });
    fireEvent.click(detail().getByRole('button', { name: i18n.t('plan.exitMode.continueButton', { ns: 'chat' }) }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledWith(plan, { decision: 'decline', answer: { type: 'answered', answers: { 'What should happen next?': 'continue_planning' }, annotations: { 'What should happen next?': { notes: 'Add rollback checks' } } }, reason: 'Add rollback checks' }));
  });
  it('preserves the filter and section state across returning from member chat', () => {
    const onViewChat = vi.fn(); const mode = makeMode({ interactions: [{ ...interaction, status: 'denied' }] });
    const view = show(mode, vi.fn(), onViewChat);
    fireEvent.click(screen.getByRole('button', { name: '已处理' }));
    fireEvent.click(screen.getByRole('button', { name: /工具调用权限询问/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看聊天' })); expect(onViewChat).toHaveBeenCalledWith('teammate-1');
    view.unmount(); show(mode);
    expect(screen.getByRole('button', { name: '已处理' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /工具调用权限询问/ }).getAttribute('aria-expanded')).toBe('false');
  });
  it('uses English labels when the language changes and keeps requests on their own member card', async () => {
    await i18n.changeLanguage('en');
    const second = { ...interaction, id: 'second', participantId: 'teammate-2', participantDisplayName: 'Builder', toolName: 'execute_command' };
    const mode = makeMode({ interactions: [interaction, second], activation: { ...makeMode().activation!, participants: [...makeMode().activation!.participants, { ...makeMode().activation!.participants[0], id: 'teammate-2', profile: { config: { displayName: 'Builder' } } } as any] } });
    show(mode); expect(screen.getByRole('heading', { name: /Team interactions/ })).toBeTruthy(); openRequest(/execute_command/);
    fireEvent.click(detail().getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(mode.respondInteraction).toHaveBeenCalledWith(second, expect.objectContaining({ decision: 'deny' })));
  });
});
