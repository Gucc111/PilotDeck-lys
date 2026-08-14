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
    expect(screen.getByText('└ Implement runtime')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
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

  it('groups teammates into active, done (collapsed), and waiting sections', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      progress: {
        summary: 'Testing MCP servers',
        items: [
          { id: 't1', subject: 'Test Alpha', status: 'completed', teammateId: 'alpha' },
          { id: 't2', subject: 'Test Bravo', status: 'in_progress', teammateId: 'bravo' },
        ],
      },
      teammates: [
        { id: 'bravo', sessionId: 's::teammate::bravo', status: 'running', currentTask: 'Test Bravo' },
        { id: 'alpha', sessionId: 's::teammate::alpha', status: 'idle' },
        { id: 'charlie', sessionId: 's::teammate::charlie', status: 'not_started' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    render(<TeamStatusPanel projectPath="/workspace" sessionId="leader" />);

    await waitFor(() => expect(screen.getByText('bravo')).toBeTruthy());
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('└ Test Bravo')).toBeTruthy();
    expect(screen.getByText('Completed (1)')).toBeTruthy();
    expect(screen.getByText('charlie')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    // alpha is in the collapsed "done" section — not visible by default
    expect(screen.queryByText('alpha')).toBeNull();
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
