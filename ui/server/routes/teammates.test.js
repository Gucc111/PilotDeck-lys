import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gateway } = vi.hoisted(() => ({
  gateway: {
    teammatesList: vi.fn(),
    teammateRead: vi.fn(),
    teammateCreate: vi.fn(),
    teammateWrite: vi.fn(),
    teammateDelete: vi.fn(),
    teammateCatalog: vi.fn(),
    teammateEnablementGet: vi.fn(),
    teammateEnablementSet: vi.fn(),
    teammateWorkspaceBindingsGet: vi.fn(),
    teammateWorkspaceBindingSet: vi.fn(),
    teamState: vi.fn(),
    reloadExtensions: vi.fn(),
  },
}));

vi.mock('../pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: async () => gateway,
}));

import teammatesRoutes from './teammates.js';

let server;
let baseUrl;

beforeEach(async () => {
  vi.clearAllMocks();
  const app = express();
  app.use(express.json());
  app.use('/api/teammates', teammatesRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('teammate settings routes', () => {
  it('lists global definitions without requiring a project path', async () => {
    gateway.teammatesList.mockResolvedValue({ teammates: [], diagnostics: [] });
    const response = await fetch(`${baseUrl}/api/teammates`);

    expect(response.status).toBe(200);
    expect(gateway.teammatesList).toHaveBeenCalledWith({});
  });

  it('creates a global teammate and reloads its global path', async () => {
    gateway.teammateRead.mockResolvedValue(null);
    gateway.teammateCreate.mockResolvedValue({
      teammate: {
        id: 'implementer',
        relativePath: 'implementer.md',
        filePath: '/pilot-home/teammates/implementer.md',
      },
    });
    const response = await fetch(`${baseUrl}/api/teammates/implementer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: {
          name: 'Implementer',
          description: 'Implements work',
          prompt: 'Implement the assigned task.',
          model: 'openai/gpt-test',
          maxContextTokens: 64000,
          maxOutputTokens: 8192,
          tools: ['read_file'],
          plugins: [],
          skills: [],
          mcpServers: [],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(gateway.teammateCreate).toHaveBeenCalledWith(expect.objectContaining({
      document: expect.objectContaining({
        schemaVersion: 1,
        id: 'implementer',
        prompt: 'Implement the assigned task.',
        maxContextTokens: 64000,
        maxOutputTokens: 8192,
      }),
    }));
    expect(gateway.reloadExtensions).toHaveBeenCalledWith({
      changedPaths: ['/pilot-home/teammates/implementer.md'],
    });
  });

  it('deletes a global teammate without a project path', async () => {
    gateway.teammateRead.mockResolvedValue({
      teammate: {
        id: 'reviewer',
        relativePath: 'reviewer.md',
        filePath: '/pilot-home/teammates/reviewer.md',
      },
    });
    gateway.teammateDelete.mockResolvedValue({
      ok: true,
      id: 'reviewer',
      relativePath: 'reviewer.md',
    });

    const response = await fetch(`${baseUrl}/api/teammates/reviewer`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(gateway.teammateRead).toHaveBeenCalledWith({ id: 'reviewer' });
    expect(gateway.teammateDelete).toHaveBeenCalledWith({ id: 'reviewer' });
    expect(gateway.reloadExtensions).toHaveBeenCalledWith({
      changedPaths: ['/pilot-home/teammates/reviewer.md'],
    });
  });

  it('gets and replaces workspace enablement before the id route', async () => {
    gateway.reloadExtensions.mockRejectedValue(new Error('Reload failed.'));
    gateway.teammateEnablementGet.mockResolvedValue({
      canonicalProjectKey: '/workspace/a',
      enabledTeammateIds: ['implementer'],
      filePath: '/pilot-home/teammate-enablement.json',
    });
    gateway.teammateEnablementSet.mockResolvedValue({
      canonicalProjectKey: '/workspace/a',
      enabledTeammateIds: ['implementer', 'reviewer'],
      filePath: '/pilot-home/teammate-enablement.json',
    });

    const getResponse = await fetch(
      `${baseUrl}/api/teammates/enablement?projectPath=${encodeURIComponent('/workspace/a')}`,
    );
    expect(getResponse.status).toBe(200);
    expect(gateway.teammateEnablementGet).toHaveBeenCalledWith({
      projectKey: '/workspace/a',
    });

    const putResponse = await fetch(`${baseUrl}/api/teammates/enablement`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/a',
        enabledTeammateIds: ['reviewer', 'implementer'],
      }),
    });
    expect(putResponse.status).toBe(200);
    expect(gateway.teammateEnablementSet).toHaveBeenCalledWith({
      projectKey: '/workspace/a',
      enabledTeammateIds: ['reviewer', 'implementer'],
    });
    expect(gateway.reloadExtensions).not.toHaveBeenCalled();
    expect(gateway.teammateRead).not.toHaveBeenCalled();
  });

  it('gets workspace bindings and updates one binding with a revision', async () => {
    gateway.teammateWorkspaceBindingsGet.mockResolvedValue({
      canonicalProjectKey: '/workspace/a',
      bindings: {
        reviewer: { enabled: true, toolProfile: { mode: 'inherit' } },
      },
      revision: 'a'.repeat(64),
      filePath: '/pilot-home/teammates/workspace-enablement.json',
    });
    gateway.teammateWorkspaceBindingSet.mockResolvedValue({
      canonicalProjectKey: '/workspace/a',
      bindings: {
        reviewer: { enabled: false, toolProfile: { mode: 'inherit' } },
      },
      revision: 'b'.repeat(64),
      filePath: '/pilot-home/teammates/workspace-enablement.json',
    });

    const getResponse = await fetch(
      `${baseUrl}/api/teammates/bindings?projectPath=${encodeURIComponent('/workspace/a')}`,
    );
    expect(getResponse.status).toBe(200);
    expect(gateway.teammateWorkspaceBindingsGet).toHaveBeenCalledWith({
      projectKey: '/workspace/a',
    });

    const putResponse = await fetch(`${baseUrl}/api/teammates/bindings/reviewer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/a',
        binding: { enabled: false, toolProfile: { mode: 'inherit' } },
        expectedRevision: 'a'.repeat(64),
      }),
    });
    expect(putResponse.status).toBe(200);
    expect(gateway.teammateWorkspaceBindingSet).toHaveBeenCalledWith({
      projectKey: '/workspace/a',
      teammateId: 'reviewer',
      binding: { enabled: false, toolProfile: { mode: 'inherit' } },
      expectedRevision: 'a'.repeat(64),
    });
  });

  it('maps workspace binding revision conflicts to HTTP 409', async () => {
    gateway.teammateWorkspaceBindingSet.mockRejectedValue(
      Object.assign(new Error('bindings changed'), { code: 'revision_conflict' }),
    );
    const response = await fetch(`${baseUrl}/api/teammates/bindings/reviewer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/a',
        binding: { enabled: true, toolProfile: { mode: 'inherit' } },
        expectedRevision: 'a'.repeat(64),
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('revision_conflict');
  });
});
