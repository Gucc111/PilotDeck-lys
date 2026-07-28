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

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const t = (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'teammates.actions.new': 'New',
        'teammates.actions.save': 'Save teammate',
        'teammates.actions.delete': 'Delete',
        'teammates.fields.id': 'Stable ID',
        'teammates.fields.name': 'Display name',
        'teammates.fields.prompt': 'Prompt',
        'teammates.fields.toolsHelp': 'Leave empty to grant no ordinary tools.',
        'teammates.enablement.toggleLabel':
          `Enabled for workspace: ${String(options?.name ?? '')}`,
        'teammates.bindings.inherit': 'Inherit default',
        'teammates.bindings.custom': 'Custom profile',
        'teammates.bindings.resetDefault': 'Reset to default',
        'teammates.bindings.toolToggleLabel':
          `${String(options?.name ?? '')} custom tool: ${String(options?.tool ?? '')}`,
        'teammates.workspace.canonical':
          `Canonical project configuration: ${String(options?.path ?? '')}`,
        'teammates.constraints.allowedScope': 'Allowed scope',
        'teammates.constraints.blockedScope': 'Blocked scope',
        'teammates.constraints.scopeType': 'Scope type',
        'teammates.constraints.tool': 'Custom tool',
        'teammates.constraints.subject': 'Subject',
        'teammates.constraints.operator': 'Operator',
        'teammates.constraints.add': 'Add scope',
        'teammates.constraints.remove': 'Remove scope',
        'teammates.constraints.executablePlaceholder': 'git',
        'teammates.constraints.argvPlaceholder': 'git status --short',
        'teammates.constraints.pathPlaceholder': '$WORKSPACE/src or /absolute/path',
        'teammates.constraints.operators.executableEquals': 'Executable equals',
        'teammates.constraints.operators.argvPrefix': 'Arguments start with',
        'teammates.constraints.operators.pathEquals': 'Path equals',
        'teammates.constraints.operators.pathWithin': 'Path is within',
        'teammates.errors.revisionConflict':
          'This workspace binding changed elsewhere. The latest server state has been reloaded.',
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
  let reads = 0;
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
      reads += 1;
      if (options?.bindingsGet) return options.bindingsGet(reads);
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

function bindingCard(name: string): HTMLElement {
  const toggle = screen.getByRole('checkbox', { name: `Enabled for workspace: ${name}` });
  const card = toggle.closest('article');
  if (!card) throw new Error(`Missing binding card for ${name}`);
  return card;
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

  it('loads workspace bindings with their revision', async () => {
    render(<TeammatesTab projects={projects} />);

    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Implementer' });
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      '/api/teammates/bindings?projectPath=%2Fworkspace',
      { suppressServerErrorToast: true },
    );
    expect(screen.getByText(/\/canonical\/workspace/)).toBeTruthy();
    expect(within(bindingCard('Implementer')).getByText('Custom profile')).toBeTruthy();
  });

  it('switches an inherited binding to a custom profile', async () => {
    render(<TeammatesTab projects={projects} />);
    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Reviewer' });
    const card = bindingCard('Reviewer');

    fireEvent.click(within(card).getByRole('radio', { name: 'Custom profile' }));

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(1));
    const payload = JSON.parse(bindingPutCalls()[0][1].body);
    expect(payload).toEqual({
      projectPath: '/workspace',
      expectedRevision: 'revision-1',
      binding: {
        enabled: false,
        toolProfile: {
          mode: 'custom',
          tools: ['bash', 'read_file'],
          constraints: { allow: [], deny: [] },
        },
      },
    });

    fireEvent.click(within(card).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(bindingPutCalls()).toHaveLength(2));
    expect(JSON.parse(bindingPutCalls()[1][1].body).binding).toEqual({
      enabled: false,
      toolProfile: { mode: 'inherit' },
    });
  });

  it('changes enablement without overwriting a custom profile', async () => {
    render(<TeammatesTab projects={projects} />);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });

    fireEvent.click(toggle);

    await waitFor(() => expect(bindingPutCalls()).toHaveLength(1));
    const payload = JSON.parse(bindingPutCalls()[0][1].body);
    expect(payload.binding).toEqual({
      enabled: false,
      toolProfile: {
        mode: 'custom',
        tools: ['bash'],
        constraints: { allow: [], deny: [] },
      },
    });
  });

  it('selects and clears custom tools from the workspace catalog', async () => {
    render(<TeammatesTab projects={projects} />);
    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Implementer' });
    const tool = within(bindingCard('Implementer')).getByRole('checkbox', {
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
    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Implementer' });
    const card = bindingCard('Implementer');

    fireEvent.change(within(card).getByPlaceholderText('git'), {
      target: { value: 'git' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Add scope' }));

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
      expect(within(card).getByRole('button', { name: 'Remove scope' })).toBeTruthy();
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Remove scope' }));
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
    installDefaultFetch({
      bindingsGet: (read) => read === 1
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
        : bindingsResponse(authoritative, 'revision-2'),
      bindingPut: () => jsonResponse({
        code: 'revision_conflict',
        error: 'Stale revision.',
      }, 409),
    });
    render(<TeammatesTab projects={projects} />);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'This workspace binding changed elsewhere.',
      );
      expect((screen.getByRole('checkbox', {
        name: 'Enabled for workspace: Implementer',
      }) as HTMLInputElement).checked).toBe(false);
    });
    expect(mocks.authenticatedFetch.mock.calls.filter(
      ([url]) => String(url).startsWith('/api/teammates/bindings?'),
    )).toHaveLength(2);
  });

  it('continues saving global definitions separately from bindings', async () => {
    render(<TeammatesTab projects={projects} />);
    await screen.findByRole('checkbox', { name: 'Enabled for workspace: Implementer' });

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.getByText('Leave empty to grant no ordinary tools.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Stable ID/), {
      target: { value: 'new-teammate' },
    });
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'New teammate' },
    });
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Do the assigned work.' },
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
    expect(JSON.parse(call?.[1]?.body)).not.toHaveProperty('projectPath');
  });
});
