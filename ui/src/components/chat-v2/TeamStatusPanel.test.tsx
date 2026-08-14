import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeamStatusPanel from './TeamStatusPanel';
import { RUN_MODE_OPTIONS } from './ComposerV2';
import { isTeammateSession } from '../../types/app';

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
          subject: 'Implement runtime',
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

  it('explains that the current workspace has no enabled and valid teammates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      progress: { items: [] },
      teammates: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    render(<TeamStatusPanel projectPath="/workspace" sessionId="leader" />);

    await waitFor(() => {
      expect(
        screen.getByText('The current workspace has no enabled and valid Teammate.'),
      ).toBeTruthy();
    });
  });

  it('uses the leader sessionId when passed explicitly (teammate view fix)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      progress: { items: [] },
      teammates: [{
        id: 'worker',
        sessionId: 'web:s_leader::teammate::worker',
        status: 'running',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamStatusPanel projectPath="/workspace" sessionId="web:s_leader" />);

    await waitFor(() => expect(screen.getByText('worker')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teammates/state?projectPath=%2Fworkspace&sessionId=web%3As_leader',
    );
  });
});

describe('isTeammateSession helper', () => {
  it('identifies a teammate session by sessionKind and parentSessionId', () => {
    expect(isTeammateSession({
      id: 'web:s_abc::teammate::foo',
      sessionKind: 'teammate',
      parentSessionId: 'web:s_abc',
    })).toBe(true);
  });

  it('returns false for a leader session', () => {
    expect(isTeammateSession({
      id: 'web:s_abc',
    })).toBe(false);
  });

  it('returns false for a background_task session', () => {
    expect(isTeammateSession({
      id: 'web:s_abc::bg',
      sessionKind: 'background_task',
      parentSessionId: 'web:s_abc',
      relativeTranscriptPath: 'subagents/abc.jsonl',
    })).toBe(false);
  });
});
