// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        'teammates.actions.edit': 'Edit',
        'teammates.fields.id': 'Stable ID',
        'teammates.fields.idHelp': 'Stable ID help',
        'teammates.fields.name': 'Display name',
        'teammates.fields.prompt': 'Prompt',
        'teammates.fields.tools': 'Tools',
        'teammates.fields.toolsHelp': 'Leave empty to grant no ordinary tools.',
        'teammates.confirmDelete': `Delete teammate "${String(options?.name ?? '')}"?`,
        'teammates.enablement.toggleLabel': `Enabled for workspace: ${String(options?.name ?? '')}`,
        'teammates.errors.enablementLoad': 'Failed to load workspace teammate enablement.',
        'teammates.errors.enablementSave': 'Failed to save workspace teammate enablement.',
        'teammates.errors.enablementUnknown': 'The enablement status is unknown. Refresh to check the server state.',
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
}, {
  name: 'workspace-b',
  displayName: 'Workspace B',
  fullPath: '/workspace-b',
}];

const implementer = {
  id: 'implementer',
  name: 'Implementer',
  description: 'Implements tasks',
  prompt: 'Implement the assigned task.',
  tools: [],
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

type FetchInit = {
  method?: string;
  body?: string;
  suppressServerErrorToast?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installDefaultFetch(options?: {
  teammates?: typeof implementer[];
  enabledTeammateIds?: string[];
  enablementGet?: (projectPath: string) => Response | Promise<Response>;
  enablementPut?: () => Response | Promise<Response>;
  teammatePut?: () => Response | Promise<Response>;
  teammateDelete?: () => Response | Promise<Response>;
}) {
  mocks.authenticatedFetch.mockImplementation(
    async (url: string, init?: FetchInit) => {
      if (url === '/api/teammates' && !init?.method) {
        return jsonResponse({
          teammates: options?.teammates ?? [implementer, reviewer],
          diagnostics: [],
        });
      }
      if (url.startsWith('/api/teammates/catalog?')) {
        return jsonResponse({
          tools: ['read'],
          plugins: [],
          skills: [],
          mcpServers: [],
          diagnostics: [],
        });
      }
      if (url.startsWith('/api/teammates/enablement?')) {
        const projectPath = new URL(url, 'http://localhost').searchParams.get('projectPath') ?? '';
        if (options?.enablementGet) return options.enablementGet(projectPath);
        return jsonResponse({
          canonicalProjectKey: projectPath,
          enabledTeammateIds: options?.enabledTeammateIds ?? [],
        });
      }
      if (url === '/api/teammates/enablement' && init?.method === 'PUT') {
        return options?.enablementPut?.() ?? jsonResponse({
          canonicalProjectKey: '/workspace',
          enabledTeammateIds: [],
        });
      }
      if (url.startsWith('/api/teammates/') && init?.method === 'PUT') {
        return options?.teammatePut?.() ?? jsonResponse({ teammate: implementer });
      }
      if (url.startsWith('/api/teammates/') && init?.method === 'DELETE') {
        return options?.teammateDelete?.() ?? jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    },
  );
}

describe('TeammatesTab', () => {
  beforeEach(() => {
    installDefaultFetch();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('loads global definitions without projectPath and reads workspace enablement separately', async () => {
    render(<TeammatesTab projects={projects} />);

    await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy());

    expect(mocks.authenticatedFetch).toHaveBeenCalledWith('/api/teammates');
    expect(
      mocks.authenticatedFetch.mock.calls.some(([url]) =>
        String(url).startsWith('/api/teammates?')),
    ).toBe(false);
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      '/api/teammates/enablement?projectPath=%2Fworkspace',
      { suppressServerErrorToast: true },
    );
  });

  it('saves global definitions and deletes them without projectPath payloads', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TeammatesTab projects={projects} />);
    await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy());

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
    const putCall = mocks.authenticatedFetch.mock.calls.find(
      ([url, init]) => url === '/api/teammates/new-teammate' && init?.method === 'PUT',
    );
    expect(JSON.parse(putCall?.[1]?.body as string)).toEqual({
      definition: expect.objectContaining({
        id: 'new-teammate',
        name: 'New teammate',
        prompt: 'Do the assigned work.',
        tools: [],
      }),
    });
    expect(JSON.parse(putCall?.[1]?.body as string)).not.toHaveProperty('projectPath');

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        '/api/teammates/implementer',
        { method: 'DELETE' },
      );
    });
  });

  it('reconciles a lost enablement response from the authoritative workspace state', async () => {
    let enablementReads = 0;
    installDefaultFetch({
      enablementGet: () => {
        enablementReads += 1;
        return jsonResponse({
          canonicalProjectKey: '/workspace',
          enabledTeammateIds:
            enablementReads === 1 ? ['implementer'] : ['implementer', 'reviewer'],
        });
      },
      enablementPut: () => {
        throw new Error('Enablement response was lost.');
      },
    });
    render(<TeammatesTab projects={projects} />);

    const implementerToggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });
    const reviewerToggle = screen.getByRole('checkbox', {
      name: 'Enabled for workspace: Reviewer',
    });
    await waitFor(() => expect((implementerToggle as HTMLInputElement).checked).toBe(true));
    expect((reviewerToggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(reviewerToggle);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Enablement response was lost.');
      expect((reviewerToggle as HTMLInputElement).checked).toBe(true);
    });
    expect(enablementReads).toBe(2);
    const enablementCall = mocks.authenticatedFetch.mock.calls.find(
      ([url, init]) => url === '/api/teammates/enablement' && init?.method === 'PUT',
    );
    expect(JSON.parse(enablementCall?.[1]?.body as string)).toEqual({
      projectPath: '/workspace',
      enabledTeammateIds: ['implementer', 'reviewer'],
    });
  });

  it('keeps the optimistic value and reports unknown status when reconciliation also fails', async () => {
    let enablementReads = 0;
    installDefaultFetch({
      enablementGet: () => {
        enablementReads += 1;
        return enablementReads === 1
          ? jsonResponse({
              canonicalProjectKey: '/workspace',
              enabledTeammateIds: ['implementer'],
            })
          : jsonResponse({ error: 'Read failed.' }, 500);
      },
      enablementPut: () => jsonResponse({ error: 'Save failed.' }, 500),
    });
    render(<TeammatesTab projects={projects} />);

    const reviewerToggle = await screen.findByRole('checkbox', {
      name: 'Enabled for workspace: Reviewer',
    });
    fireEvent.click(reviewerToggle);

    await waitFor(() => {
      expect((reviewerToggle as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain(
        'The enablement status is unknown. Refresh to check the server state.',
      );
    });
    expect(enablementReads).toBe(2);
  });

  it('reloads the selected workspace after a delayed global save', async () => {
    const saveResponse = deferred<Response>();
    installDefaultFetch({
      enablementGet: (path) => jsonResponse({
        canonicalProjectKey: path,
        enabledTeammateIds: path === '/workspace' ? ['implementer'] : ['reviewer'],
      }),
      teammatePut: () => saveResponse.promise,
    });
    render(<TeammatesTab projects={projects} />);
    await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
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

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/workspace-b' } });
    const implementerToggle = screen.getByRole('checkbox', {
      name: 'Enabled for workspace: Implementer',
    });
    const reviewerToggle = screen.getByRole('checkbox', {
      name: 'Enabled for workspace: Reviewer',
    });
    await waitFor(() => {
      expect((implementerToggle as HTMLInputElement).checked).toBe(false);
      expect((reviewerToggle as HTMLInputElement).checked).toBe(true);
    });
    const workspaceAReads = countEnablementReads('/workspace');

    saveResponse.resolve(jsonResponse({ teammate: implementer }));
    await waitFor(() => expect(screen.getByText('teammates.status.saved')).toBeTruthy());
    expect(countEnablementReads('/workspace')).toBe(workspaceAReads);
    expect((implementerToggle as HTMLInputElement).checked).toBe(false);
    expect((reviewerToggle as HTMLInputElement).checked).toBe(true);
  });

  it('reloads the selected workspace after a delayed global delete', async () => {
    const deleteResponse = deferred<Response>();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installDefaultFetch({
      enablementGet: (path) => jsonResponse({
        canonicalProjectKey: path,
        enabledTeammateIds: path === '/workspace' ? ['implementer'] : ['reviewer'],
      }),
      teammateDelete: () => deleteResponse.promise,
    });
    render(<TeammatesTab projects={projects} />);
    await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        '/api/teammates/implementer',
        { method: 'DELETE' },
      );
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '/workspace-b' } });
    const reviewerToggle = screen.getByRole('checkbox', {
      name: 'Enabled for workspace: Reviewer',
    });
    await waitFor(() => expect((reviewerToggle as HTMLInputElement).checked).toBe(true));
    const workspaceAReads = countEnablementReads('/workspace');

    deleteResponse.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.getByText('teammates.status.deleted')).toBeTruthy());
    expect(countEnablementReads('/workspace')).toBe(workspaceAReads);
    expect((reviewerToggle as HTMLInputElement).checked).toBe(true);
  });
});

function countEnablementReads(projectPath: string): number {
  const expectedUrl =
    `/api/teammates/enablement?projectPath=${encodeURIComponent(projectPath)}`;
  return mocks.authenticatedFetch.mock.calls.filter(
    ([url, init]) => url === expectedUrl && !init?.method,
  ).length;
}
