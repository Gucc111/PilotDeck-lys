import { describe, expect, it } from 'vitest';

import { mapWebMessageToNormalized } from './messages.js';

describe('Team message history projection', () => {
  it('matches the stable realtime activity shape after refresh', () => {
    const normalized = mapWebMessageToNormalized({
      id: 'entry-1',
      sessionKey: 'web:s_test',
      createdAt: '2026-07-24T00:00:00.000Z',
      provider: 'pilotdeck',
      role: 'system',
      kind: 'status',
      text: 'reviewer: Need a decision.',
      source: 'history',
      payload: {
        event: 'team_message',
        detail: {
          messageId: 'message-1',
          teammateId: 'reviewer',
          message: 'Need a decision.',
          kind: 'explicit',
        },
      },
    }, 'web:s_test');

    expect(normalized).toMatchObject({
      id: 'team_message_message-1',
      kind: 'agent_activity',
      phase: 'team',
      state: 'completed',
      title: 'Message from reviewer',
      detail: 'Need a decision.',
      teammateId: 'reviewer',
      startedAt: '2026-07-24T00:00:00.000Z',
      endedAt: '2026-07-24T00:00:00.000Z',
    });
  });

  it('keeps failed teammate reports as failed Team activity', () => {
    const normalized = mapWebMessageToNormalized({
      id: 'entry-2',
      sessionKey: 'web:s_test',
      createdAt: '2026-07-24T00:00:01.000Z',
      provider: 'pilotdeck',
      role: 'error',
      kind: 'error',
      text: 'Tests failed.',
      source: 'history',
      payload: {
        event: 'teammate_failed',
        detail: {
          messageId: 'message-2',
          teammateId: 'tester',
          message: 'Tests failed.',
          kind: 'failure',
        },
      },
    }, 'web:s_test');

    expect(normalized).toMatchObject({
      id: 'team_message_message-2',
      kind: 'agent_activity',
      state: 'failed',
      severity: 'error',
      title: 'tester reported a failure',
    });
  });
});
