import express from 'express';
import { getPilotDeckGateway, hasPendingSessionInputs, invalidateTeamSessionInputs } from '../pilotdeck-bridge.js';

const actions = new Set([
  'library', 'inventory', 'profile_save', 'profile_fork', 'profile_archive',
  'team_save', 'team_fork', 'team_archive', 'project_references',
  'runtime_probe', 'runtime_select', 'runtime_get', 'runtime_stop',
]);

export function teamErrorStatus(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/NOT_FOUND$/.test(code)) return 404;
  if (/INVALID_INPUT|VALIDATION|ROLE_MISMATCH|PROJECT_REQUIRED/.test(code)) return 400;
  if (/CONFLICT|REFERENCED|PROTECTED|ARCHIVED|BUSY|MISMATCH|STALE|EXPIRED|STOPPING/.test(code)) return 409;
  if (/UNAVAILABLE|CORRUPT/.test(code) || /Gateway WebSocket|ECONNREFUSED|connect timeout|gateway is not connected/i.test(error?.message || '')) return 503;
  return 500;
}

export function createTeamLibraryHandler({ getGateway = getPilotDeckGateway, hasPendingInputs = hasPendingSessionInputs, invalidateInputs = invalidateTeamSessionInputs } = {}) {
  return async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !actions.has(input.action)) {
      return res.status(400).json({ error: { code: 'TEAM_INVALID_INPUT', message: 'A valid team-library action is required.' } });
    }
    try {
      if (input.action === 'runtime_select' && hasPendingInputs(input.sessionKey)) {
        throw Object.assign(new Error('Finish or remove queued inputs before changing this conversation’s Team.'), { code: 'TEAM_BUSY' });
      }
      if (input.action === 'runtime_stop' && typeof input.activationId === 'string' && Number.isInteger(input.stopVersion)) invalidateInputs(input.sessionKey, 'abort', { activationId: input.activationId, stopVersion: input.stopVersion });
      const gateway = await getGateway();
      if (!gateway.teamCommand || (typeof gateway.describeServer === 'function'
        && !(await gateway.describeServer()).capabilities?.includes('team_command'))) {
        return res.status(503).json({ error: { code: 'CAPABILITY_UNAVAILABLE', message: 'This Gateway does not support Team configuration.' } });
      }
      return res.json(await gateway.teamCommand(input));
    } catch (error) {
      return res.status(teamErrorStatus(error)).json({ error: {
        code: typeof error?.code === 'string' ? error.code : 'gateway_request_failed',
        message: error instanceof Error ? error.message : String(error),
        ...(error?.details !== undefined ? { details: error.details } : {}),
      } });
    }
  };
}

const router = express.Router();
router.post('/', createTeamLibraryHandler());
export default router;
