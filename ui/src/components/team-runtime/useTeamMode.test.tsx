// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamMode, hasTeamWork } from './useTeamMode';
import type { TeamDefinition } from '../team-library/api';
import type { TeamRuntimeActivation, TeamRuntimeProbe } from '../../../../src/team/runtimeTypes';
import type { Project } from '../../types/app';
const command = vi.hoisted(() => vi.fn());
vi.mock('../team-library/api', async () => ({ ...(await vi.importActual('../team-library/api')), teamCommand: command }));
const config = { displayName: 'Reviewer', description: '', systemPrompt: 'Review carefully', model: { mode: 'default' as const }, workspace: { mode: 'team' as const }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' as const };
const leader = { id: 'leader', revision: 1, role: 'leader' as const, config, archived: false, createdAt: '', updatedAt: '' };
export const team: TeamDefinition = { id: 'team-one', revision: 2, config: { displayName: 'Release review', description: '', instructions: '', defaultProjectKey: '/work', leader: { id: 'leader', revision: 1 }, teammates: [{ id: 'reviewer', revision: 1 }] }, leader, teammates: [{ ...leader, id: 'reviewer', role: 'teammate' }], archived: false, createdAt: '', updatedAt: '' };
const project = { name: 'work', fullPath: '/work', path: '/work' } as Project;
const general = { name: 'general', fullPath: '/general', path: '/general', kind: 'general' } as Project;
const probe: TeamRuntimeProbe = { team, projectKey: '/work', participants: [], issues: [], fingerprint: 'fingerprint', compatible: true };
const activation: TeamRuntimeActivation = { id: 'activation-1', sessionKey: 'web:s_one', projectKey: '/work', team, participants: [], probeFingerprint: 'fingerprint', status: 'active', createdAt: '', updatedAt: '', works: [], messages: [], notifications: [], automaticWakeups: 0, stopVersion: 0 };
const props = { sessionKey: null as string | null, project, projects: [project], busy: false };
beforeEach(() => { localStorage.clear(); command.mockReset(); command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : input.action === 'runtime_probe' ? probe : { activation: null }); });
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
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: 'runtime_select', sessionKey: 'web:s_one', storageProjectKey: '/general', projectKey: '/work', team: { id: team.id, revision: 2 } }));
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
    const running = { ...activation, works: [{ id: 'work', participantId: 'reviewer', task: 'Review', status: 'waiting_approval' as const, createdAt: '' }] };
    command.mockImplementation(async (input) => input.action === 'library' ? { teams: [team], profiles: [] } : { activation: input.action === 'runtime_stop' ? { ...running, status: 'stopped' } : running });
    const hook = renderHook(() => useTeamMode({ ...props, sessionKey: 'web:s_one' }));
    await waitFor(() => expect(hook.result.current.working).toBe(true));
    expect(hasTeamWork(running)).toBe(true);
    await act(async () => expect(await hook.result.current.selectSolo()).toBe(false));
    await act(() => hook.result.current.stop());
    expect(command).toHaveBeenCalledWith({ action: 'runtime_stop', sessionKey: 'web:s_one' });
    expect(hook.result.current.working).toBe(false);
  });
});
