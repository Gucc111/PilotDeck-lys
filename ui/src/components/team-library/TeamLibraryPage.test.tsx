// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamLibraryPage from './TeamLibraryPage';
import type { AgentProfile, TeamDefinition, TeamLibrary } from './api';
import { DEFAULT_LEADER_PROMPT, DRAFT_KEY, newProfileDraft, readDrafts } from './drafts';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), command: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), teamCommand: mocks.command }));
vi.mock('../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-user' } }) }));
const profile = (id: string, role: 'leader' | 'teammate'): AgentProfile => ({ id, role, createdAt: '2026-10-22', updatedAt: '2026-10-22', config: { displayName: id, description: 'Research', systemPrompt: 'Study documents carefully.', model: { mode: 'default' }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, permissionMode: 'default' } });
const leader = profile('Director', 'leader'), teammate = profile('Researcher', 'teammate');
const team: TeamDefinition = { id: 'team-1', createdAt: '2026-10-22', updatedAt: '2026-10-22', config: { displayName: 'Reports', description: 'Monthly reports', instructions: '', defaultProjectKey: '/project', leader: { id: leader.id }, teammates: [{ id: teammate.id }] }, leader, teammates: [teammate] };
let library: TeamLibrary;
const mount = () => render(<TeamLibraryPage projects={[{ name: 'project', displayName: 'Project', fullPath: '/project' }]} onCreateProject={vi.fn()}/>);
beforeEach(() => { localStorage.clear(); library = { profiles: [leader, teammate], teams: [team] }; mocks.command.mockReset(); mocks.fetch.mockReset(); mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 'test/large', provider: 'test', model: 'large', displayName: 'Large', available: true }] }) }); mocks.command.mockImplementation(async (command: any) => { if (command.action === 'library') return library; if (command.action === 'inventory') return { tools: ['read_file', 'write_file', 'edit_file', 'edit_notebook', 'enter_plan_mode', 'exit_plan_mode', 'todo_write'].map(name => ({ name, description: `Description for ${name}` })), skills: [{ name: 'research', description: 'Research skills' }], mcpServers: [] }; if (command.action === 'profile_save') return { ...profile(command.id || 'new-profile', command.role), config: command.config }; if (command.action === 'team_save') return { ...team, config: command.config }; throw new Error(`Unexpected ${command.action}`); }); });
afterEach(cleanup);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const loaded = () => screen.findByRole('heading', { name: 'Reports' });
describe('team library workflow', () => {
  it('prefills a fresh Leader prompt through both creation paths and preserves edited drafts', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    expect((screen.getByLabelText('System prompt') as HTMLTextAreaElement).value).toBe(DEFAULT_LEADER_PROMPT);
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Custom leader' } });
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toContain('Custom leader'));
    cleanup(); mount(); await screen.findByRole('dialog');
    expect((screen.getByLabelText('System prompt') as HTMLTextAreaElement).value).toBe('Custom leader');
    click('Discard draft'); click('New team'); click('Create new Leader');
    expect((screen.getByLabelText('System prompt') as HTMLTextAreaElement).value).toBe(DEFAULT_LEADER_PROMPT);
    expect(newProfileDraft('teammate').config.systemPrompt).toBe('');
  });
  it.each(['Leaders', 'Teammates'])('requires an explicit model and omits plan approval for %s', async tab => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: tab })); click(tab === 'Leaders' ? 'New Leader' : 'New Teammate');
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('test/large'));
    expect(screen.queryByRole('option', { name: 'Use system default' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Plan mode' })).toBeNull();
    expect((screen.getByLabelText('Execution approval') as HTMLSelectElement).value).toBe('default');
  });
  it('cannot submit a profile when the model catalog has no concrete model', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Leader' } });
    fireEvent.submit(document.getElementById('team-profile-form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose a specific model.');
    expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'profile_save')).toBe(false);
  });
  it.each(['Leaders', 'Teammates'])('groups tools and enforces read dependencies for %s', async tab => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: tab })); click(tab === 'Leaders' ? 'New Leader' : 'New Teammate');
    const read = await screen.findByLabelText('read_file') as HTMLInputElement;
    await waitFor(() => expect(read.disabled).toBe(false));
    expect(screen.queryByText('Description for read_file')).toBeNull();
    expect(screen.getByText('Research skills')).toBeTruthy();
    expect(screen.queryByLabelText('write_file')).toBeNull();
    const writes = screen.getByLabelText('write_file / edit_file') as HTMLInputElement;
    const notebook = screen.getByLabelText('edit_notebook') as HTMLInputElement;
    expect(notebook.disabled).toBe(true);
    fireEvent.click(read); expect(read.checked).toBe(true); fireEvent.click(read); expect(read.checked).toBe(false);
    fireEvent.click(writes); expect(read.checked).toBe(true); expect(read.disabled).toBe(true); expect(notebook.checked).toBe(false); expect(notebook.disabled).toBe(false);
    fireEvent.click(notebook); expect(notebook.checked).toBe(true);
    fireEvent.click(screen.getByLabelText('enter_plan_mode / exit_plan_mode'));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Configured' } });
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Work together.' } });
    click('Save');
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'profile_save', config: expect.objectContaining({ capabilities: { tools: ['write_file', 'edit_file', 'read_file', 'edit_notebook', 'enter_plan_mode', 'exit_plan_mode', 'todo_write'], skills: [], mcpServers: [] } }) })));
  });
  it.each(['Leaders', 'Teammates'])('locks todo with plan tools and permits todo alone for %s', async tab => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: tab })); click(tab === 'Leaders' ? 'New Leader' : 'New Teammate');
    const todo = await screen.findByLabelText('todo_write') as HTMLInputElement;
    await waitFor(() => expect(todo.disabled).toBe(false));
    expect(screen.queryByText('Optional')).toBeNull();
    fireEvent.click(todo); expect(todo.checked).toBe(true);
    fireEvent.click(todo); expect(todo.checked).toBe(false);
    const plan = screen.getByLabelText('enter_plan_mode / exit_plan_mode');
    fireEvent.click(plan); expect(todo.checked).toBe(true); expect(todo.disabled).toBe(true);
    fireEvent.click(plan); expect(todo.checked).toBe(true); expect(todo.disabled).toBe(false);
    fireEvent.click(todo); expect(todo.checked).toBe(false);
    fireEvent.click(todo);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Todo only' } });
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Track tasks.' } });
    click('Save');
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'profile_save', config: expect.objectContaining({ capabilities: { tools: ['todo_write'], skills: [], mcpServers: [] } }) })));
    const saved = mocks.command.mock.calls.find(([arg]) => arg.action === 'profile_save')![0];
    expect(saved.config).not.toHaveProperty('optionalCapabilities');
  });
  it('restores a legacy Optional draft as a required profile and repairs plan dependencies', async () => {
    const draft = newProfileDraft('leader');
    draft.config.displayName = 'Legacy plan';
    draft.config.model = { mode: 'model', provider: 'test', model: 'large' };
    draft.config.capabilities.tools = ['enter_plan_mode'];
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ profile: { ...draft, config: { ...draft.config, optionalCapabilities: [{ kind: 'tool', name: 'enter_plan_mode' }] } } }));
    expect(readDrafts().profile!.config).not.toHaveProperty('optionalCapabilities');
    mount();
    const todo = await screen.findByLabelText('todo_write') as HTMLInputElement;
    await waitFor(() => { expect(todo.checked).toBe(true); expect(todo.disabled).toBe(true); });
    click('Save');
    await waitFor(() => expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'profile_save')).toBe(true));
    const saved = mocks.command.mock.calls.find(([arg]) => arg.action === 'profile_save')![0];
    expect(saved.config).not.toHaveProperty('optionalCapabilities');
    expect(saved.config.capabilities.tools).toEqual(['enter_plan_mode', 'exit_plan_mode', 'todo_write']);
  });
  it('removes notebook selection with the write group and allows read to be cleared afterward', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    const writes = await screen.findByLabelText('write_file / edit_file') as HTMLInputElement;
    await waitFor(() => expect(writes.disabled).toBe(false));
    fireEvent.click(writes); fireEvent.click(screen.getByLabelText('edit_notebook')); fireEvent.click(writes);
    expect((screen.getByLabelText('edit_notebook') as HTMLInputElement).checked).toBe(false);
    const read = screen.getByLabelText('read_file') as HTMLInputElement;
    expect(read.disabled).toBe(false); expect(read.checked).toBe(true);
    fireEvent.click(read); expect(read.checked).toBe(false);
  });
  it('saves a reusable profile without starting work and generates no client identity', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Editor' } }); fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Review drafts.' } });
    fireEvent.click(await screen.findByLabelText('read_file')); click('Save');
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'profile_save', config: expect.objectContaining({ displayName: 'Editor', capabilities: { tools: ['read_file'], skills: [], mcpServers: [] } }) })));
    const command = mocks.command.mock.calls.find(([arg]) => arg.action === 'profile_save')![0]; expect(command.id).toBeUndefined(); expect(command.requestToken).toBeTruthy(); expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'start')).toBe(false);
  });
  it('lets a Teammate enter any local directory while Leaders keep the registered project picker', async () => {
    mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Teammates' })); click('New Teammate');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'fixed' } });
    const teammateInput = document.querySelector<HTMLInputElement>('.team-workspace-input input');
    expect(teammateInput).toBeTruthy(); expect(teammateInput!.placeholder).toBe('/absolute/path/to/directory');
    expect((screen.getByRole('button', { name: 'Choose directory' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(teammateInput!, { target: { value: '/arbitrary/team-directory' } });
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith({ action: 'inventory', projectKey: '/arbitrary/team-directory' }));
    cleanup(); mount(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Leaders' })); click('New Leader');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'fixed' } });
    expect(screen.getByLabelText('Use a fixed project')).toHaveProperty('tagName', 'SELECT');
    expect(screen.queryByRole('button', { name: 'Choose directory' })).toBeNull();
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
    fireEvent.click(screen.getByLabelText('Researcher')); click('Save'); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_save', config: expect.objectContaining({ leader: { id: leader.id }, teammates: [{ id: teammate.id }] }) })));
    expect(mocks.command.mock.calls.some(([arg]) => arg.action === 'start')).toBe(false);
  });
  it('saves member IDs so the Team follows the latest profile configuration', async () => {
    library.profiles = [profile(leader.id, 'leader'), teammate]; mount(); await loaded(); click('Details'); click('Edit');
    expect(screen.queryByText('Update available')).toBeNull(); click('Save'); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_save', config: expect.objectContaining({ leader: { id: leader.id }, teammates: [{ id: teammate.id }] }) })));
  });
  it('forks a team with a new identity and retains selected member references', async () => {
    mocks.command.mockImplementation(async (command: any) => command.action === 'library' ? library : command.action === 'team_fork' ? { ...team, id: 'forked-team', config: { ...team.config, displayName: command.displayName } } : undefined);
    mount(); await loaded(); click('Details'); click('Copy and edit (Fork)'); const dialogs = screen.getAllByRole('dialog'); const dialog = dialogs[dialogs.length - 1]; fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Competitors' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Copy and edit (Fork)' }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'team_fork', source: { id: team.id }, displayName: 'Competitors' }))); await screen.findByRole('dialog', { name: 'Edit Team' }); expect((screen.getByLabelText('Leader') as HTMLSelectElement).value).toBe(leader.id);
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
  it('deletes a team from the library', async () => {
    mocks.command.mockImplementation(async (command: any) => command.action === 'library' ? library : command.action === 'team_delete' ? team : undefined);
    mount(); await loaded(); click('Details'); click('Delete'); const dialogs = screen.getAllByRole('dialog'); fireEvent.click(within(dialogs[dialogs.length - 1]).getByRole('button', { name: 'Delete' })); await waitFor(() => expect(mocks.command).toHaveBeenCalledWith({ action: 'team_delete', id: team.id, requestToken: expect.any(String) }));
  });
});
