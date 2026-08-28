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

function optionalPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function sendError(res, error) {
  const code = error?.code || error?.details?.code;
  const status = error?.statusCode
    || (code === 'not_found' ? 404
      : code === 'conflict' || code === 'duplicate_id' || code === 'revision_conflict' ? 409
        : code === 'validation_failed' || code === 'invalid_input' || code === 'invalid_id' ? 400
          : 500);
  res.status(status).json({
    error: error instanceof Error ? error.message : String(error),
    code,
    validation: error?.validation || error?.details?.validation,
  });
}

router.get('/catalog', async (req, res) => {
  try {
    const projectKey = requireProjectPath(req.query.projectPath);
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teammateCatalog({ projectKey }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/state', async (req, res) => {
  try {
    const projectKey = requireProjectPath(req.query.projectPath);
    const leaderSessionId = String(req.query.sessionId || '').trim();
    if (!leaderSessionId) {
      return res.status(400).json({ error: 'sessionId is required.' });
    }
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamState({ projectKey, leaderSessionId }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/', async (req, res) => {
  try {
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teammatesList({}));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const definition = req.body?.definition || {};
    const maxContextTokens = optionalPositiveInteger(definition.maxContextTokens);
    const maxOutputTokens = optionalPositiveInteger(definition.maxOutputTokens);
    const document = {
      schemaVersion: 1,
      id,
      name: definition.name || id,
      description: definition.description || '',
      ...(definition.model ? { model: definition.model } : {}),
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      tools: Array.isArray(definition.tools) ? definition.tools : [],
      plugins: Array.isArray(definition.plugins) ? definition.plugins : [],
      skills: Array.isArray(definition.skills) ? definition.skills : [],
      mcpServers: Array.isArray(definition.mcpServers) ? definition.mcpServers : [],
      prompt: definition.prompt || '',
    };
    const gateway = await getPilotDeckGateway();
    const existing = await gateway.teammateRead({ id });
    const result = existing
      ? await gateway.teammateWrite({ id, document })
      : await gateway.teammateCreate({ document });
    await gateway.reloadExtensions?.({
      changedPaths: [result.teammate.filePath],
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const gateway = await getPilotDeckGateway();
    const existing = await gateway.teammateRead({ id });
    const result = await gateway.teammateDelete({ id });
    await gateway.reloadExtensions?.({
      changedPaths: existing?.teammate?.filePath ? [existing.teammate.filePath] : [],
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
