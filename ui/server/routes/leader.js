import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

function sendError(res, error) {
  const code = error?.code || error?.details?.code;
  const status = error?.statusCode
    || (code === 'not_found' ? 404
      : code === 'revision_conflict' ? 409
        : code === 'validation_failed' || code === 'invalid_input' ? 400
          : 500);
  res.status(status).json({
    error: error instanceof Error ? error.message : String(error),
    code,
    validation: error?.validation || error?.details?.validation,
  });
}

router.get('/', async (_req, res) => {
  try {
    const gateway = await getPilotDeckGateway();
    const result = await gateway.leaderRead({});
    res.json(result ?? { leader: null });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/', async (req, res) => {
  try {
    const definition = req.body?.definition || {};
    const document = {
      schemaVersion: 1,
      ...(definition.model ? { model: definition.model } : {}),
      ...(typeof definition.maxContextTokens === 'number' ? { maxContextTokens: definition.maxContextTokens } : {}),
      ...(typeof definition.maxOutputTokens === 'number' ? { maxOutputTokens: definition.maxOutputTokens } : {}),
      tools: Array.isArray(definition.tools) ? definition.tools : [],
      plugins: Array.isArray(definition.plugins) ? definition.plugins : [],
      skills: Array.isArray(definition.skills) ? definition.skills : [],
      mcpServers: Array.isArray(definition.mcpServers) ? definition.mcpServers : [],
      prompt: definition.prompt || '',
    };
    const gateway = await getPilotDeckGateway();
    const result = await gateway.leaderWrite({ document });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
