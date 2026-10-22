// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamLibraryPage from './TeamLibraryPage';
import type { AgentProfile, TeamDefinition, TeamLibrary } from './api';
import { DRAFT_KEY } from './drafts';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), command: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), teamCommand: mocks.command }));
const profile = (id: string, role: 'leader' | 'teammate', revision = 1): AgentProfile => ({ id, revision, role, archived: false, createdAt: '2026-10-22', updatedAt: '2026-10-22', config: { displayName: id, description: 'Research', systemPrompt: 'Study documents carefully.', model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' } });
const leader = profile('Director', 'leader'), teammate = profile('Researcher', 'teammate');
const team: TeamDefinition = { id: 'team-1', revision: 1, archived: false, createdAt: '2026-10-22', updatedAt: '2026-10-22', config: { displayName: 'Reports', description: 'Monthly reports', instructions: '', defaultProjectKey: '/project', leader: { id: leader.id, revision: 1 }, teammates: [{ id: teammate.id, revision: 1 }] }, leader, teammates: [teammate] };
let library: TeamLibrary;
const mount = () => render(<TeamLibraryPage projects={[{ name: 'project', displayName: 'Project', fullPath: '/project' }]} onCreateProject={vi.fn()}/>);
beforeEach(() => { localStorage.clear(); library = { profiles: [leader, teammate], teams: [team] }; mocks.command.mockReset(); mocks.fetch.mockReset(); mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }); mocks.command.mockImplementation(async (command: any) => { if (command.action === 'library') return library; if (command.action === 'inventory') return { tools: [{ name: 'read_file', description: 'Read files' }], skills: [], mcpServers: [] }; if (command.action === 'profile_save') return { ...profile(command.id || 'new-profile', command.role), config: command.config }; if (command.action === 'team_save') return { ...team, revision: 2, config: command.config }; throw new Error(`Unexpected ${command.action}`); }); });
afterEach(cleanup);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const loaded = () => screen.findByRole('heading', { name: 'Reports' });
describe('team library workflow', () => {
  it('saves a reusable profile without starting work and generates no client identity', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Editor' } }); fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review drafts.' } });
    fireEvent.click(await screen.findByLabelText('read_file')); click('Save');
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'profile_save', config: expect.objectContaining({ displayName: 'Editor', capabilities: { tools: ['read_file'], skills: [], mcpServers: [] } }) })));
    const command = mocks.command.mock.calls.find(([arg]) => arg.action === 'profile_save')![0]; expect(command.id).toBeUndefined(); expect(command.requestToken).toBeTruthy(); expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'start')).toBe(false);
  });
  it('browses project capabilities without pinning an inherited workspace', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    fireEvent.change(screen.getByLabelText('Browse capabilities from'), { target: { value: '/project' } });
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith({ action: 'inventory', projectKey: '/project' }));
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('team');
  });
  it('restores unfinished drafts after unmount and refresh', async () => {
    const first = mount(); await loaded(); click('New team'); fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Unfinished report' } });
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toContain('Unfinished report')); first.unmount(); mount(); await screen.findByRole('dialog'); expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Unfinished report');
  });
  it('requires one teammate and keeps team saving separate from conversations', async () => {
    mount(); await loaded(); click('New team'); fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Weekly' } }); fireEvent.change(screen.getByLabelText('Leader'), { target: { value: leader.id } }); click('Save'); expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose at least one Teammate.');
    fireEvent.click(screen.getByLabelText('Researcher')); click('Save'); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_save', config: expect.objectContaining({ teammates: [{ id: teammate.id, revision: 1 }] }) })));
    expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'start')).toBe(false);
  });
  it('adopts a profile update only after an explicit choice and save', async () => {
    library.profiles = [profile(leader.id, 'leader', 2), teammate]; mount(); await loaded(); click('Details'); click('Edit');
    expect(screen.getByText('Update available')).toBeTruthy(); click('Use latest'); click('Save'); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_save', config: expect.objectContaining({ leader: { id: leader.id, revision: 2 } }) })));
  });
  it('forks a team with a new identity and retains selected member references', async () => {
    mocks.command.mockImplementation(async (command: any) => command.action === 'library' ? library : command.action === 'team_fork' ? { ...team, id: 'forked-team', config: { ...team.config, displayName: command.displayName } } : undefined);
    mount(); await loaded(); click('Details'); click('Copy and edit (Fork)'); const dialogs = screen.getAllByRole('dialog'); const dialog = dialogs[dialogs.length - 1]; fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Competitors' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Copy and edit (Fork)' }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_fork', source: { id: team.id, revision: 1 }, displayName: 'Competitors' }))); await screen.findByRole('dialog', { name: 'Edit Team' }); expect((screen.getByLabelText('Leader') as HTMLSelectElement).value).toBe(leader.id);
  });
  it('creates a teammate inline and returns to the same team draft', async () => {
    mount(); await loaded(); click('New team'); fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Inline team' } }); click('Create new Teammate'); fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Writer' } }); fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Write clearly.' } }); click('Save');
    await screen.findByRole('dialog', { name: 'New team' }); expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Inline team'); expect((screen.getByLabelText('Writer') as HTMLInputElement).checked).toBe(true);
  });
  it('ignores a legacy start attempt and offers only configuration management', async () => {
    localStorage.setItem('pilotdeck:team-library:start:v1', JSON.stringify({ team, requestToken: 'obsolete-attempt', submitted: true }));
    mount(); await loaded();
    expect(screen.queryByRole('button', { name: /start|open leader|open conversation/i })).toBeNull();
    click('Details');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy and edit (Fork)' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Conversations' })).toBeNull();
    expect(screen.queryByRole('button', { name: /start|open leader|open conversation/i })).toBeNull();
    expect(mocks.command.mock.calls.map(([command]) => command.action)).toEqual(['library']);
  });
  it('retains a stable creation token after a lost save response', async () => {
    let calls = 0; mocks.command.mockImplementation(async (command: any) => { if (command.action === 'library') return library; if (command.action === 'team_save') { calls++; if (calls === 1) throw new Error('Response lost'); return { ...team, config: command.config }; } });
    mount(); await loaded(); click('Details'); click('Edit'); click('Save'); await screen.findByText('Response lost'); expect((screen.getByLabelText('Display name') as HTMLInputElement).disabled).toBe(true); click('Retry'); await waitFor(() => expect(mocks.command.mock.calls.filter(([arg]) => arg.action === 'team_save')).toHaveLength(2));
    const callsList = mocks.command.mock.calls.filter(([arg]) => arg.action === 'team_save'); expect(callsList[0][0]).toEqual(callsList[1][0]);
  });
  it('archives without deleting existing team configurations', async () => {
    mocks.command.mockImplementation(async (command: any) => command.action === 'library' ? library : command.action === 'team_archive' ? { ...team, archived: true } : undefined);
    mount(); await loaded(); click('Details'); click('Archive'); const dialogs = screen.getAllByRole('dialog'); fireEvent.click(within(dialogs[dialogs.length - 1]).getByRole('button', { name: 'Archive' })); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith({ action: 'team_archive', id: team.id, expectedRevision: 1, archived: true }));
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
  });
});
