// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn() }));
import { createTeamLibraryHandler } from './team-library.js';

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

describe('Team library HTTP boundary', () => {
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
