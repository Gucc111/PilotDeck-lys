// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamMode, hasTeamWork } from './useTeamMode';
import type { TeamDefinition } from '../team-library/api';
import type { TeamRuntimeActivation, TeamRuntimeProbe } from '../../../../src/team/runtimeTypes';
import type { Project } from '../../types/app';
const command = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({ listeners: new Set<(message: unknown) => void>(), subscribe: vi.fn((listener: (message: unknown) => void) => { socket.listeners.add(listener); return () => { socket.listeners.delete(listener); }; }) }));
vi.mock('../../contexts/WebSocketContext', () => ({ useOptionalWebSocket: () => socket }));
vi.mock('../team-library/api', async () => ({ ...(await vi.importActual('../team-library/api')), teamCommand: command }));
const config = { displayName: 'Reviewer', description: '', systemPrompt: 'Review carefully', model: { mode: 'default' as const }, workspace: { mode: 'team' as const }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' as const };
const leader = { id: 'leader', role: 'leader' as const, config, createdAt: '', updatedAt: '' };
export const team: TeamDefinition = { id: 'team-one', config: { displayName: 'Release review', description: '', instructions: '', defaultProjectKey: '/work', leader: { id: 'leader' }, teammates: [{ id: 'reviewer' }] }, leader, teammates: [{ ...leader, id: 'reviewer', role: 'teammate' }], createdAt: '', updatedAt: '' };
const project = { name: 'work', fullPath: '/work', path: '/work' } as Project;
const general = { name: 'general', fullPath: '/general', path: '/general', kind: 'general' } as Project;
const probe: TeamRuntimeProbe = { team, projectKey: '/work', participants: [], issues: [], fingerprint: 'fingerprint', compatible: true };
const activation: TeamRuntimeActivation = { id: 'activation-1', sessionKey: 'web:s_one', projectKey: '/work', team, participants: [], probeFingerprint: 'fingerprint', status: 'active', createdAt: '', updatedAt: '', works: [], messages: [], notifications: [], interactions: [], automaticWakeups: 0, stopVersion: 0 };
const props = { sessionKey: null as string | null, project, projects: [project], busy: false };
beforeEach(() => { localStorage.clear(); socket.listeners.clear(); command.mockReset(); command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_probe' ? probe : { activation: null }); });
afterEach(cleanup);

describe('Team mode current conversation selection', () => {
  it('selects a blank Team without starting runtime and preserves the root/token across reload', async () => {
    const hook = renderHook(() => useTeamMode(props));
    await waitFor(() => expect(hook.result.current.teams).toHaveLength(1));
    act(() => hook.result.current.selectTeam(team));
    await waitFor(() => expect(hook.result.current.choice?.probe).toEqual(probe));
    await act(() => hook.result.current.confirmChoice());
    const selection = hook.result.current.teamSelection;
    const root = hook.result.current.teamDraftSessionId;
    expect(root).toMatch(/^web:s_/);
    expect(selection?.probeFingerprint).toBe('fingerprint');
    expect(command.mock.calls.some(([input]) => input.action === 'runtime_select')).toBe(false);
    hook.unmount();
    const reopened = renderHook(() => useTeamMode(props));
    expect(reopened.result.current.teamSelection).toEqual(selection);
    expect(reopened.result.current.teamDraftSessionId).toBe(root);
  });

  it('binds an existing General conversation in place while execution uses a registered project', async () => {
    command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_probe' ? probe : input.action === 'runtime_select' ? { activation } : { activation: null });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one', project: general, projects: [general, project] }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.selectTeam(team));
    await waitFor(() => expect(hook.result.current.choice?.probe).toEqual(probe));
    await act(() => hook.result.current.confirmChoice());
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: 'runtime_select', sessionKey: 'web:s_one', storageProjectKey: '/general', projectKey: '/work', team: { id: team.id } }));
    expect(hook.result.current.teamActivationId).toBe('activation-1');
  });

  it('discards an old probe after quickly choosing another Team', async () => {
    let resolveOld!: (value: TeamRuntimeProbe) => void;
    command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_probe' && input.team.id === team.id ? new Promise(resolve => { resolveOld = resolve; }) : { ...probe, team: { ...team, id: 'second' } });
    const hook = renderHook(() => useTeamMode(props));
    const second = { ...team, id: 'second', config: { ...team.config, displayName: 'Second' } };
    act(() => hook.result.current.selectTeam(team));
    act(() => hook.result.current.selectTeam(second));
    await waitFor(() => expect(hook.result.current.choice?.probe?.team.id).toBe('second'));
    await act(async () => resolveOld(probe));
    expect(hook.result.current.choice?.team.id).toBe('second');
  });

  it('blocks sending when runtime identity cannot be read and allows a successful retry', async () => {
    command.mockImplementation(async (input) => { if (input.action === 'library') return { teams: [team], profiles: [] }; throw new Error('Team store unavailable'); });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one' }));
    await waitFor(() => expect(hook.result.current.error).toBe('Team store unavailable'));
    expect(hook.result.current.ready).toBe(false);
    await act(async () => expect(await hook.result.current.selectSolo()).toBe(false));
    command.mockResolvedValue({ activation });
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.selectedTeam?.id).toBe(team.id);
    expect(hook.result.current.ready).toBe(true);
  });

  it('keeps earlier Team records inspectable after leaving Team mode', async () => {
    command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : { activation });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one' }));
    await waitFor(() => expect(hook.result.current.teamActivationId).toBe(activation.id));
    command.mockResolvedValue({ activation: null });
    await act(() => hook.result.current.selectSolo());
    expect(hook.result.current.selectedTeam).toBeNull();
    expect(hook.result.current.history.map(item => item.id)).toEqual([activation.id]);
    command.mockResolvedValue({ activation: null, history: [{ ...activation, status: 'closed' }] });
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.history[0].status).toBe('closed');
  });

  it('prevents mode switches for pending member work and stops the whole activation', async () => {
    const running = { ...activation, turns: [{ turnId: 'turn', stopVersion: 0, participantId: 'reviewer', trigger: 'messages' as const, status: 'waiting_approval' as const, startedAt: '', messageIds: [], requestIds: [] }] };
    command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : { activation: input.action === 'runtime_stop' ? { ...running, status: 'stopped' } : running });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one' }));
    await waitFor(() => expect(hook.result.current.working).toBe(true));
    expect(hasTeamWork(running)).toBe(true);
    await act(async () => expect(await hook.result.current.selectSolo()).toBe(false));
    await act(() => hook.result.current.stop());
    expect(command).toHaveBeenCalledWith({ action: 'runtime_stop', sessionKey: 'web:s_one', activationId: 'activation-1', stopVersion: 0 });
    expect(hook.result.current.working).toBe(false);
  });
});

it('keeps the clicked run identity when a stop response races a refresh and blocks sends while cleaning up', async () => {
  let reply!: (view: unknown) => void;
  const stopping = { ...activation, stopVersion: 1, status: 'stopping', cleanup: { startedAt: '', pending: ['member'], timedOut: true } };
  command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_stop' ? new Promise(resolve => { reply = resolve; }) : { activation });
  const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one' }));
  await waitFor(() => expect(hook.result.current.activation?.id).toBe(activation.id));
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.stop(); });
  expect(command).toHaveBeenCalledWith({ action: 'runtime_stop', sessionKey: 'web:s_one', activationId: activation.id, stopVersion: 0 });
  await act(async () => { reply({ activation: stopping }); await pending; });
  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.locked).toBe(true);
});

const pendingInteraction = { id: 'interaction-one', requestId: 'request-one', activationId: activation.id, sessionKey: activation.sessionKey, stopVersion: 0, participantId: 'reviewer', participantDisplayName: 'Reviewer', kind: 'tool_permission' as const, toolName: 'write_file', request: {}, status: 'pending' as const, createdAt: '2026-01-01T00:00:00Z' };
const withInteraction = { ...activation, participants: [{ id: 'reviewer', role: 'teammate', profile: team.teammates[0] } as any], interactions: [pendingInteraction] };
function emit(interaction: unknown, type = 'team-interaction-updated') {
  for (const listener of socket.listeners) listener({ type, sessionKey: activation.sessionKey, activationId: activation.id, interaction });
}

describe('Team human-interaction state fencing', () => {
  it('does not let a stale HTTP snapshot or delayed pending event undo a handled event', async () => {
    let resolveSnapshot!: (value: unknown) => void;
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : { activation: withInteraction });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.interactions).toHaveLength(1));
    command.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    let refresh!: Promise<void>; act(() => { refresh = hook.result.current.refresh(); });
    const handled = { ...pendingInteraction, status: 'allowed', resolvedAt: '2026-01-01T00:01:00Z' };
    act(() => emit(handled));
    await act(async () => { resolveSnapshot({ activation: withInteraction }); await refresh; });
    expect(hook.result.current.interactions[0].status).toBe('allowed');
    act(() => emit(pendingInteraction, 'team-interaction'));
    expect(hook.result.current.interactions[0].status).toBe('allowed');
  });
  it('rejects events from another owner or generation and clears old caches after leaving Team mode', async () => {
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_select' ? { activation: null } : { activation: withInteraction });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.interactions).toHaveLength(1));
    for (const change of [{ participantId: 'unknown' }, { sessionKey: 'other' }, { activationId: 'other' }, { stopVersion: 2 }]) act(() => emit({ ...pendingInteraction, ...change, status: 'allowed' }));
    expect(hook.result.current.interactions[0].status).toBe('pending');
    await act(async () => { await hook.result.current.selectSolo(); });
    expect(hook.result.current.interactions).toEqual([]);
    act(() => emit({ ...pendingInteraction, status: 'allowed' }));
    expect(hook.result.current.interactions).toEqual([]);
  });
  it('never restores an old stop generation after stop completes', async () => {
    let snapshot!: (value: unknown) => void;
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : { activation: withInteraction });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.interactions).toHaveLength(1));
    command.mockImplementation(input => input.action === 'runtime_stop' ? Promise.resolve({ activation: { ...withInteraction, status: 'stopped', stopVersion: 1, interactions: [{ ...pendingInteraction, status: 'cancelled' }] } }) : new Promise(resolve => { snapshot = resolve; }));
    let refresh!: Promise<void>; act(() => { refresh = hook.result.current.refresh(); });
    await act(() => hook.result.current.stop());
    await act(async () => { snapshot({ activation: withInteraction }); await refresh; });
    expect(hook.result.current.activation?.stopVersion).toBe(1);
    expect(hook.result.current.interactions[0].status).toBe('cancelled');
  });
  it('retains pending on response failure and hydrates multiple ledger pages', async () => {
    const older = { ...pendingInteraction, id: 'older', requestId: 'older-request', status: 'denied' };
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_interaction_respond' ? { delivered: false, interaction: pendingInteraction } : input.cursor ? { activation: { ...withInteraction, interactions: [older] } } : { activation: withInteraction, interactionsNextCursor: 'page-2' });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.interactions).toHaveLength(2));
    await act(async () => { await expect(hook.result.current.respondInteraction(pendingInteraction, { decision: 'allow' })).rejects.toThrow(); });
    expect(hook.result.current.interactions[0].status).toBe('pending');
  });
  it('hydrates from runtime_get on WebSocket reconnection', async () => {
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] } : { activation: withInteraction });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.interactions).toHaveLength(1));
    command.mockResolvedValue({ activation: { ...withInteraction, interactions: [{ ...pendingInteraction, status: 'expired' }] } });
    act(() => { for (const listener of socket.listeners) listener({ type: 'websocket-reconnected' }); });
    await waitFor(() => expect(hook.result.current.interactions[0].status).toBe('expired'));
  });
  it('hydrates message and turn pages and retains a successful deletion against stale snapshots', async () => {
    const message = { id: 'message-1', senderId: 'reviewer', recipientId: 'leader', intendedRecipientId: 'leader', text: 'Keep the API?', status: 'invalidated' as const, stopVersion: 0, createdAt: '' };
    const current = { ...activation, stopVersion: 1, messages: [message] };
    const second = { ...message, id: 'message-2' };
    const turn = { turnId: 'turn-1', participantId: 'reviewer', stopVersion: 0, trigger: 'messages' as const, status: 'ended' as const, startedAt: '', messageIds: [], requestIds: [] };
    command.mockImplementation(async input => input.action === 'library' ? { teams: [team], profiles: [] }
      : input.action === 'runtime_message_delete' ? { messageId: message.id, deleted: true }
      : input.messageCursor ? { activation: { ...current, messages: [second] } }
      : input.turnCursor ? { activation: { ...current, turns: [turn] } }
      : { activation: current, messagesNextCursor: 'messages-2', turnsNextCursor: 'turns-2' });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: activation.sessionKey }));
    await waitFor(() => expect(hook.result.current.activation?.messages).toHaveLength(2));
    expect(hook.result.current.activation?.turns).toHaveLength(1);
    await act(() => hook.result.current.deleteMessage(message));
    expect(command).toHaveBeenCalledWith({ action: 'runtime_message_delete', sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: 0, participantId: 'leader', messageId: message.id });
    expect(hook.result.current.activation?.messages.find(item => item.id === message.id)?.status).toBe('deleted');
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.activation?.messages.find(item => item.id === message.id)?.status).toBe('deleted');
  });
});
