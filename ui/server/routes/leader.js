import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

function requireProjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('projectPath is required.');
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

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

router.get('/override', async (req, res) => {
  try {
    const projectKey = requireProjectPath(req.query.projectPath);
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.leaderWorkspaceOverrideGet({ projectKey }));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/override', async (req, res) => {
  try {
    const projectKey = requireProjectPath(req.body?.projectPath);
    const expectedRevision = req.body?.expectedRevision;
    if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
      return res.status(400).json({ error: 'expectedRevision is required.' });
    }
    if (!req.body?.override || typeof req.body.override !== 'object' || Array.isArray(req.body.override)) {
      return res.status(400).json({ error: 'override must be an object.' });
    }
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.leaderWorkspaceOverrideSet({
      projectKey,
      override: req.body.override,
      expectedRevision,
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/override', async (req, res) => {
  try {
    const projectKey = requireProjectPath(req.query.projectPath || req.body?.projectPath);
    const expectedRevision = req.query.expectedRevision || req.body?.expectedRevision;
    if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
      return res.status(400).json({ error: 'expectedRevision is required.' });
    }
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.leaderWorkspaceOverrideDelete({
      projectKey,
      expectedRevision,
    }));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
