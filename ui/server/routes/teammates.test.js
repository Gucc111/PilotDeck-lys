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
  it('lists only the requested workspace', async () => {
    gateway.teammatesList.mockResolvedValue({ teammates: [], diagnostics: [] });
    const response = await fetch(`${baseUrl}/api/teammates?projectPath=${encodeURIComponent('/workspace/a')}`);

    expect(response.status).toBe(200);
    expect(gateway.teammatesList).toHaveBeenCalledWith({ projectKey: '/workspace/a' });
  });

  it('creates a project teammate and reloads extensions', async () => {
    gateway.teammateRead.mockResolvedValue(null);
    gateway.teammateCreate.mockResolvedValue({
      teammate: { id: 'implementer', relativePath: 'implementer.md' },
    });
    const response = await fetch(`${baseUrl}/api/teammates/implementer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/a',
        definition: {
          name: 'Implementer',
          description: 'Implements work',
          prompt: 'Implement the assigned task.',
          model: 'openai/gpt-test',
          tools: ['read_file'],
          plugins: [],
          skills: [],
          mcpServers: [],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(gateway.teammateCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectKey: '/workspace/a',
      document: expect.objectContaining({
        schemaVersion: 1,
        id: 'implementer',
        prompt: 'Implement the assigned task.',
      }),
    }));
    expect(gateway.reloadExtensions).toHaveBeenCalledWith({
      projectKey: '/workspace/a',
      changedPaths: ['.pilotdeck/teammates/implementer.md'],
    });
  });
});
