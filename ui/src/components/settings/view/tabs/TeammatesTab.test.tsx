// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeammatesTab from './TeammatesTab';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock('../../../../hooks/usePilotDeckConfig', () => ({
  usePilotDeckConfig: () => ({
    raw: 'schemaVersion: 1\nmodel:\n  providers: {}\n',
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const t = (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'teammates.title': 'Teammates',
        'teammates.description': 'Manage teammates.',
        'teammates.actions.new': 'New',
        'teammates.actions.refresh': 'Refresh',
        'teammates.actions.save': 'Save teammate',
        'teammates.actions.saving': 'Saving...',
        'teammates.actions.cancel': 'Cancel',
        'teammates.actions.delete': 'Delete',
        'teammates.fields.id': 'Stable ID',
        'teammates.fields.name': 'Display name',
        'teammates.fields.prompt': 'Prompt',
        'teammates.fields.maxOutputTokens': 'Max output tokens',
        'teammates.fields.maxOutputTokensHelp': 'Output help.',
        'teammates.fields.maxContextTokens': 'Max context tokens',
        'teammates.fields.maxContextTokensHelp': 'Context help.',
        'teammates.fields.toolsHelp': 'Leave empty to grant no ordinary tools.',
        'teammates.placeholders.maxOutputTokens': '65536',
        'teammates.placeholders.maxContextTokens': '128000',
        'teammates.validation.positiveInteger': 'Enter a positive integer or leave this empty.',
        'teammates.list.toolCount': `${String(options?.count ?? 0)} tool(s)`,
        'teammates.list.workspaceCount': `${String(options?.count ?? 0)} workspace(s)`,
        'teammates.enablement.toggleLabel':
          `Enabled for workspace: ${String(options?.name ?? '')}`,
        'teammates.enablement.rowLabel': 'Enabled for workspace',
        'teammates.bindings.inherit': 'Inherit default',
        'teammates.bindings.custom': 'Custom profile',
        'teammates.bindings.customStatus': 'Custom',
        'teammates.bindings.inheritedStatus': 'Inherited',
        'teammates.bindings.effectiveTools': `${String(options?.count ?? 0)} effective tool(s)`,
        'teammates.bindings.resetDefault': 'Reset to default',
        'teammates.bindings.copyDefaults': 'Copy default tools',
        'teammates.bindings.toolToggleLabel':
          `${String(options?.name ?? '')} custom tool: ${String(options?.tool ?? '')}`,
        'teammates.bindings.loading': 'Loading workspace bindings...',
        'teammates.bindings.toolsTitle': 'Custom tools',
        'teammates.bindings.toolsDescription': 'Select tools.',
        'teammates.workspace.canonical':
          `Canonical project configuration: ${String(options?.path ?? '')}`,
        'teammates.workspace.none': 'Select a workspace.',
        'teammates.constraints.title': 'Capability constraints',
        'teammates.constraints.description': 'Description.',
        'teammates.constraints.allowedScope': 'Allowed scope',
        'teammates.constraints.blockedScope': 'Blocked scope',
        'teammates.constraints.scopeType': 'Scope type',
        'teammates.constraints.tool': 'Custom tool',
        'teammates.constraints.subject': 'Subject',
        'teammates.constraints.operator': 'Operator',
        'teammates.constraints.add': 'Add scope',
        'teammates.constraints.remove': 'Remove scope',
        'teammates.constraints.empty': 'No capability constraints.',
        'teammates.constraints.selectToolFirst': 'Select a tool first.',
        'teammates.constraints.executablePlaceholder': 'git',
        'teammates.constraints.argvPlaceholder': 'git status --short',
        'teammates.constraints.pathPlaceholder': '$WORKSPACE/src or /absolute/path',
        'teammates.constraints.operators.executableEquals': 'Executable equals',
        'teammates.constraints.operators.argvPrefix': 'Arguments start with',
        'teammates.constraints.operators.pathEquals': 'Path equals',
        'teammates.constraints.operators.pathWithin': 'Path is within',
        'teammates.errors.revisionConflict':
          'This workspace binding changed elsewhere. The latest server state has been reloaded.',
        'teammates.detail.backToList': 'Back to list',
        'teammates.detail.definitionTab': 'Definition',
        'teammates.detail.workspacesTab': 'Workspaces',
        'teammates.workspacePanel.on': 'On',
        'teammates.workspacePanel.off': 'Off',
        'teammates.loading': 'Loading teammates...',
        'teammates.empty': 'No teammates defined.',
        'teammates.diagnostics.global': 'Global diagnostics',
        'teammates.editor.new': 'New teammate',
      };
      return translations[key] ?? key;
    };
    return () => ({ t });
  })(),
}));

const projects = [{
  name: 'workspace',
  displayName: 'Workspace',
  fullPath: '/workspace',
}];

const implementer = {
  id: 'implementer',
  name: 'Implementer',
  description: 'Implements tasks',
  prompt: 'Implement the assigned task.',
  maxContextTokens: 64000,
  maxOutputTokens: 8192,
  tools: ['bash', 'read_file'],
  plugins: [],
  skills: [],
  mcpServers: [],
};

const reviewer = {
  ...implementer,
  id: 'reviewer',
  name: 'Reviewer',
  prompt: 'Review the assigned task.',
};

type Selector = {
  version: 2;
  toolName: string;
  conditions?: Array<Record<string, unknown>>;
};

type Binding = {
  enabled: boolean;
  toolProfile:
    | { mode: 'inherit' }
    | {
        mode: 'custom';
        tools: string[];
        constraints: { allow: Selector[]; deny: Selector[] };
      };
};

type FetchInit = {
  method?: string;
  body?: string;
  suppressServerErrorToast?: boolean;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installDefaultFetch(options?: {
  bindings?: Record<string, Binding>;
  bindingsGet?: (read: number) => Response | Promise<Response>;
  bindingPut?: (
    teammateId: string,
    body: { projectPath: string; binding: Binding; expectedRevision: string },
  ) => Response | Promise<Response>;
}) {
  let revision = 'revision-1';
  const readCounts: Record<string, number> = {};
  let bindings = structuredClone(options?.bindings ?? {
    implementer: {
      enabled: true,
      toolProfile: {
        mode: 'custom' as const,
        tools: ['bash'],
        constraints: { allow: [], deny: [] },
      },
    },
    reviewer: {
      enabled: false,
      toolProfile: { mode: 'inherit' as const },
    },
  });

  mocks.authenticatedFetch.mockImplementation(async (url: string, init?: FetchInit) => {
    if (url === '/api/teammates' && !init?.method) {
      return jsonResponse({ teammates: [implementer, reviewer], diagnostics: [] });
    }
    if (url.startsWith('/api/teammates/catalog?')) {
      return jsonResponse({
        tools: ['bash', 'read_file', 'write_file'],
        plugins: [],
        skills: [],
        mcpServers: [],
        diagnostics: [],
      });
    }
    if (url.startsWith('/api/teammates/bindings?')) {
      const projectPath = new URL(url, 'http://test').searchParams.get('projectPath') ?? '';
      readCounts[projectPath] = (readCounts[projectPath] ?? 0) + 1;
      if (options?.bindingsGet) return options.bindingsGet(readCounts[projectPath]);
      return bindingsResponse(bindings, revision);
    }
    if (url.startsWith('/api/teammates/bindings/') && init?.method === 'PUT') {
      const teammateId = decodeURIComponent(url.slice('/api/teammates/bindings/'.length));
      const body = JSON.parse(init.body ?? '{}');
      if (options?.bindingPut) return options.bindingPut(teammateId, body);
      bindings = { ...bindings, [teammateId]: body.binding };
      revision = `revision-${Number(revision.split('-')[1]) + 1}`;
      return bindingsResponse(bindings, revision);
    }
    if (url.startsWith('/api/teammates/') && init?.method === 'PUT') {
      return jsonResponse({ teammate: implementer });
    }
    if (url.startsWith('/api/teammates/') && init?.method === 'DELETE') {
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
}

function bindingsResponse(bindings: Record<string, Binding>, revision: string) {
  return jsonResponse({
    canonicalProjectKey: '/canonical/workspace',
    bindings,
    revision,
    filePath: '/pilot-home/teammate-enablement.json',
  });
}

async function navigateToTeammate(name: string) {
  const card = await screen.findByText(name);
  fireEvent.click(card.closest('button')!);
}

async function switchToWorkspacesTab() {
  const workspacesTab = await screen.findByText('Workspaces');
  fireEvent.click(workspacesTab);
}

async function expandWorkspace(label: string) {
  const wsButton = await screen.findByText(label);
  fireEvent.click(wsButton.closest('button')!);
}

function bindingPutCalls() {
  return mocks.authenticatedFetch.mock.calls.filter(
    ([url, init]) => String(url).startsWith('/api/teammates/bindings/')
      && init?.method === 'PUT',
  );
}

describe('TeammatesTab', () => {
  beforeEach(() => installDefaultFetch());

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('renders teammate list with tool counts', async () => {
    render(<TeammatesTab projects={projects} />);

    await screen.findByText('Implementer');
    expect(screen.getByText('Reviewer')).toBeTruthy();
    expect(screen.getAllByText('2 tool(s)').length).toBe(2);
  });

  it('navigates to detail and shows workspace bindings', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    const toggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });
    expect(toggle).toBeTruthy();
    expect(screen.getAllByText('Custom').length).toBeGreaterThanOrEqual(1);
  });

  it('switches an inherited binding to a custom profile', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Reviewer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Reviewer' });
    fireEvent.click(screen.getByRole('radio', { name: 'Custom profile' }));

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(1));
    const payload = JSON.parse(bindingPutCalls()[0][1].body);
    expect(payload).toEqual({
      projectPath: '/workspace',
      expectedRevision: 'revision-1',
      binding: {
        enabled: false,
        contextPolicy: 'persistent',
        toolProfile: {
          mode: 'custom',
          tools: ['bash', 'read_file'],
          constraints: { allow: [], deny: [] },
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(bindingPutCalls()).toHaveLength(2));
    expect(JSON.parse(bindingPutCalls()[1][1].body).binding).toEqual({
      enabled: false,
      contextPolicy: 'persistent',
      toolProfile: { mode: 'inherit' },
    });
  });

  it('changes enablement without overwriting a custom profile', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    const toggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(1));
    const payload = JSON.parse(bindingPutCalls()[0][1].body);
    expect(payload.binding).toEqual({
      enabled: false,
      contextPolicy: 'persistent',
      toolProfile: {
        mode: 'custom',
        tools: ['bash'],
        constraints: { allow: [], deny: [] },
      },
    });
  });

  it('selects and clears custom tools from the workspace catalog', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    const tool = await screen.findByRole('checkbox', {
      name: 'Implementer custom tool: read_file',
    });

    fireEvent.click(tool);
    await waitFor(() => expect((tool as HTMLInputElement).checked).toBe(true));
    fireEvent.click(tool);

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(2));
    const first = JSON.parse(bindingPutCalls()[0][1].body);
    const second = JSON.parse(bindingPutCalls()[1][1].body);
    expect(first.binding.toolProfile.tools).toEqual(['bash', 'read_file']);
    expect(second.binding.toolProfile.tools).toEqual(['bash']);
  });

  it('adds and removes capability constraints', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Implementer' });

    fireEvent.click(screen.getByText('Capability constraints'));

    fireEvent.change(screen.getByPlaceholderText('git'), {
      target: { value: 'git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add scope' }));

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(1));
    expect(JSON.parse(bindingPutCalls()[0][1].body).binding.toolProfile.constraints.allow)
      .toEqual([{
        version: 2,
        toolName: 'bash',
        conditions: [{
          subject: 'bash.command',
          operator: 'executableEquals',
          value: 'git',
        }],
      }]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove scope' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove scope' }));
    await waitFor(() => expect(bindingPutCalls()).toHaveLength(2));
    expect(JSON.parse(bindingPutCalls()[1][1].body).binding.toolProfile.constraints.allow)
      .toEqual([]);
  });

  it('reloads and warns on a revision conflict', async () => {
    const authoritative = {
      implementer: {
        enabled: false,
        toolProfile: { mode: 'inherit' as const },
      },
      reviewer: {
        enabled: false,
        toolProfile: { mode: 'inherit' as const },
      },
    };
    let readCount = 0;
    installDefaultFetch({
      bindingsGet: () => {
        readCount += 1;
        return readCount <= 1
          ? bindingsResponse({
              implementer: {
                enabled: true,
                toolProfile: {
                  mode: 'custom',
                  tools: ['bash'],
                  constraints: { allow: [], deny: [] },
                },
              },
              reviewer: authoritative.reviewer,
            }, 'revision-1')
          : bindingsResponse(authoritative, 'revision-2');
      },
      bindingPut: () => jsonResponse({
        code: 'revision_conflict',
        error: 'Stale revision.',
      }, 409),
    });
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');
    await switchToWorkspacesTab();
    await expandWorkspace('Workspace');

    const toggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'This workspace binding changed elsewhere.',
      );
    });
  });

  it('shows and clears teammate token limits in global definitions', async () => {
    render(<TeammatesTab projects={projects} />);

    await navigateToTeammate('Implementer');

    const output = screen.getByLabelText(/Max output tokens/) as HTMLInputElement;
    const context = screen.getByLabelText(/Max context tokens/) as HTMLInputElement;
    expect(output.value).toBe('8192');
    expect(context.value).toBe('64000');

    fireEvent.change(output, { target: { value: '' } });
    fireEvent.change(context, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save teammate' }));

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        '/api/teammates/implementer',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const call = mocks.authenticatedFetch.mock.calls.find(
      ([url, init]) => url === '/api/teammates/implementer' && init?.method === 'PUT',
    );
    const payload = JSON.parse(call?.[1]?.body);
    expect(payload.definition).not.toHaveProperty('maxContextTokens');
    expect(payload.definition).not.toHaveProperty('maxOutputTokens');
  });

  it('continues saving global definitions separately from bindings', async () => {
    render(<TeammatesTab projects={projects} />);

    await screen.findByText('Implementer');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(screen.getByLabelText(/Max output tokens/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Stable ID/), {
      target: { value: 'new-teammate' },
    });
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'New teammate' },
    });
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Do the assigned work.' },
    });
    fireEvent.change(screen.getByLabelText(/Max output tokens/), {
      target: { value: '4096' },
    });
    fireEvent.change(screen.getByLabelText(/Max context tokens/), {
      target: { value: '32000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save teammate' }));

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        '/api/teammates/new-teammate',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const call = mocks.authenticatedFetch.mock.calls.find(
      ([url, init]) => url === '/api/teammates/new-teammate' && init?.method === 'PUT',
    );
    const payload = JSON.parse(call?.[1]?.body);
    expect(payload).not.toHaveProperty('projectPath');
    expect(payload.definition).toEqual(expect.objectContaining({
      maxOutputTokens: 4096,
      maxContextTokens: 32000,
    }));
  });
});
