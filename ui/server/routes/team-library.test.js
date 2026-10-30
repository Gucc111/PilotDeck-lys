// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), hasPendingSessionInputs: vi.fn(() => false), invalidateTeamSessionInputs: vi.fn() }));
import { createTeamLibraryHandler } from './team-library.js';

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

describe('Team library HTTP boundary', () => {
  it('forwards message deletion with the original recipient and generation', async () => {
    const input = { action: 'runtime_message_delete', sessionKey: 'web:team', activationId: 'a', stopVersion: 2, participantId: 'leader', messageId: 'message-1' };
    const teamCommand = vi.fn(async () => ({ messageId: 'message-1', deleted: true }));
    const res = response();
    await createTeamLibraryHandler({ getGateway: async () => ({ teamCommand }) })({ body: input }, res);
    expect(teamCommand).toHaveBeenCalledExactlyOnceWith(input);
    expect(res.body).toEqual({ messageId: 'message-1', deleted: true });
  });
  it('routes interaction responses to the dedicated consumer and preserves a pending failure', async () => {
    const input = { action: 'runtime_interaction_respond', sessionKey: 'web:team', activationId: 'a', stopVersion: 3, participantId: 'mate', interactionId: 'i', requestId: 'r', kind: 'user_question', answer: { type: 'answered', answers: { checks: ['unit', 'browser'] } } };
    const result = { delivered: false, interaction: { ...input, id: 'i', status: 'pending' } };
    const teamCommand = vi.fn();
    const teamInteractionRespond = vi.fn(async () => result);
    const res = response();
    await createTeamLibraryHandler({ getGateway: async () => ({ teamCommand, teamInteractionRespond }) })({ body: input }, res);
    expect(teamInteractionRespond).toHaveBeenCalledExactlyOnceWith(input);
    expect(teamCommand).not.toHaveBeenCalled();
    expect(res.body).toEqual(result);
  });

  it('reads only the specified member and preserves transcript pagination and streaming identity', async () => {
    const input = { action: 'runtime_participant_messages', sessionKey: 'web:team', activationId: 'a', stopVersion: 3, participantId: 'mate', cursor: '200', limit: 100 };
    const result = { sessionKey: input.sessionKey, activationId: 'a', participantId: 'mate', stopVersion: 3, messages: [{ id: 'block', text: 'partial' }], nextCursor: '300', streamEpoch: 'epoch', revision: 9, streaming: true };
    const teamCommand = vi.fn();
    const teamParticipantMessages = vi.fn(async () => result);
    const res = response();
    await createTeamLibraryHandler({ getGateway: async () => ({ teamCommand, teamParticipantMessages }) })({ body: input }, res);
    expect(teamParticipantMessages).toHaveBeenCalledExactlyOnceWith(input);
    expect(teamCommand).not.toHaveBeenCalled();
    expect(res.body).toEqual(result);
  });

  it.each(['runtime_interaction_respond', 'runtime_participant_messages'])('does not fall back to generic commands when %s is unavailable', async action => {
    const teamCommand = vi.fn();
    const res = response();
    await createTeamLibraryHandler({ getGateway: async () => ({ teamCommand }) })({ body: { action } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(teamCommand).not.toHaveBeenCalled();
  });

  it('forwards the exact command and returns the domain result', async () => {
    const result = { profiles: [], teams: [] };
    const teamCommand = vi.fn(async () => result);
    const handler = createTeamLibraryHandler({ getGateway: async () => ({ teamCommand }) });
    const res = response();
    await handler({ body: { action: 'library' } }, res);
    expect(teamCommand).toHaveBeenCalledWith({ action: 'library' });
    expect(res.body).toEqual(result);
    expect(res.statusCode).toBe(200);
  });

  it('rejects unknown or missing actions without connecting to Gateway', async () => {
    const getGateway = vi.fn();
    const handler = createTeamLibraryHandler({ getGateway });
    for (const body of [null, [], {}, { action: 'erase_everything' }, { action: 'start' }, { action: 'probe' }, { action: 'conversation_get' }]) {
      const res = response();
      await handler({ body }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('TEAM_INVALID_INPUT');
    }
    expect(getGateway).not.toHaveBeenCalled();
  });

  it('forwards runtime commands but blocks a mode switch while inputs are pending', async () => {
    const teamCommand = vi.fn(async () => ({ activation: null }));
    const getGateway = vi.fn(async () => ({ teamCommand }));
    const handler = createTeamLibraryHandler({ getGateway, hasPendingInputs: () => true });
    const res = response();
    await handler({ body: { action: 'runtime_select', sessionKey: 'web:team', team: null, requestToken: 'switch' } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('TEAM_BUSY');
    expect(getGateway).not.toHaveBeenCalled();
    const read = response();
    await handler({ body: { action: 'runtime_get', sessionKey: 'web:team' } }, read);
    expect(read.body).toEqual({ activation: null });
  });

  it('invalidates only the captured Team generation before stopping', async () => {
    const order = [];
    const handler = createTeamLibraryHandler({ invalidateInputs: (sessionKey, reason, identity) => order.push(['invalidate', sessionKey, identity]), getGateway: async () => ({ teamCommand: async command => { order.push(['stop', command.sessionKey]); return { activation: null }; } }) });
    await handler({ body: { action: 'runtime_stop', sessionKey: 'web:team', activationId: 'a', stopVersion: 2 } }, response());
    expect(order).toEqual([['invalidate', 'web:team', { activationId: 'a', stopVersion: 2 }], ['stop', 'web:team']]);
  });

  it.each([
    ['TEAM_INVALID_INPUT', 400], ['TEAM_PROFILE_NOT_FOUND', 404],
    ['TEAM_REVISION_CONFLICT', 409], ['TEAM_PROTECTED', 409],
    ['CAPABILITY_UNAVAILABLE', 503], ['TEAM_STORE_CORRUPT', 503],
  ])('maps %s to %i and keeps actionable details', async (code, status) => {
    const error = Object.assign(new Error('Readable reason'), { code, details: { field: 'config.model' } });
    const handler = createTeamLibraryHandler({ getGateway: async () => ({ teamCommand: async () => { throw error; } }) });
    const res = response();
    await handler({ body: { action: 'library' } }, res);
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: { code, message: 'Readable reason', details: { field: 'config.model' } } });
  });

  it('reports unsupported servers and disconnections as unavailable', async () => {
    const unknown = vi.fn();
    for (const getGateway of [async () => ({}), async () => ({ teamCommand: unknown, describeServer: async () => ({ capabilities: [] }) }), async () => { throw new Error('Gateway WebSocket closed.'); }]) {
      const res = response();
      await createTeamLibraryHandler({ getGateway })({ body: { action: 'library' } }, res);
      expect(res.statusCode).toBe(503);
    }
    expect(unknown).not.toHaveBeenCalled();
  });
});
