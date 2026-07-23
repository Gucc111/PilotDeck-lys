import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeamStatusPanel from './TeamStatusPanel';
import { RUN_MODE_OPTIONS } from './ComposerV2';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Agent Teams chat UI', () => {
  it('offers Team as a run mode', () => {
    expect(RUN_MODE_OPTIONS.map((option) => option.mode)).toContain('team');
  });

  it('renders persistent teammate and progress state', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      progress: {
        summary: 'Implementation in progress',
        items: [{
          id: 'task-1',
          content: 'Implement runtime',
          status: 'in_progress',
          teammateId: 'implementer',
        }],
      },
      teammates: [{
        id: 'implementer',
        sessionId: 'leader::teammate::implementer',
        status: 'running',
        currentTask: 'Implement runtime',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamStatusPanel projectPath="/workspace" sessionId="leader" />);

    await waitFor(() => expect(screen.getByText('implementer')).toBeTruthy());
    expect(screen.getAllByText('Implement runtime').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teammates/state?projectPath=%2Fworkspace&sessionId=leader',
    );
  });
});
