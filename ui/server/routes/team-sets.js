import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} is required.`);
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
        : code === 'invalid_input' || code === 'invalid_schema' || code === 'invalid_id' ? 400
          : 500);
  res.status(status).json({
    error: error instanceof Error ? error.message : String(error),
    code,
  });
}

router.get('/assignment', async (req, res) => {
  try {
    const projectKey = requireString(req.query.projectPath, 'projectPath');
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetWorkspaceAssignmentGet({ projectKey }));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/assignment', async (req, res) => {
  try {
    const projectKey = requireString(req.body?.projectKey, 'projectKey');
    const expectedRevision = requireString(req.body?.expectedRevision, 'expectedRevision');
    const teamSetId = req.body?.teamSetId ?? null;
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetWorkspaceAssignmentSet({
      projectKey,
      teamSetId,
      expectedRevision,
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/', async (_req, res) => {
  try {
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetList());
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = requireString(req.params.id, 'id');
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetRead({ id }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const teamSet = req.body?.teamSet;
    if (!teamSet || typeof teamSet !== 'object' || Array.isArray(teamSet)) {
      return res.status(400).json({ error: 'teamSet must be an object.' });
    }
    const gateway = await getPilotDeckGateway();
    res.status(201).json(await gateway.teamSetCreate({ teamSet }));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = requireString(req.params.id, 'id');
    const expectedRevision = requireString(req.body?.expectedRevision, 'expectedRevision');
    const teamSet = req.body?.teamSet;
    if (!teamSet || typeof teamSet !== 'object' || Array.isArray(teamSet)) {
      return res.status(400).json({ error: 'teamSet must be an object.' });
    }
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetWrite({ id, teamSet, expectedRevision }));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = requireString(req.params.id, 'id');
    const gateway = await getPilotDeckGateway();
    res.json(await gateway.teamSetDelete({ id }));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
