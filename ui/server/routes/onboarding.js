import express from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { addProjectManually } from '../projects.js';
import { validateWorkspacePath, cloneGitHubRepository } from './projects.js';
import { readPilotDeckConfigFile, writePilotDeckConfig } from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import { probeModelConnection } from '../services/modelConnectionProbe.js';

const router = express.Router();
const TEST_TTL_MS = 10 * 60 * 1000;
const tests = new Map();
const ALIASES = { gemini: 'google', kimi: 'moonshot', volcengine: 'volc_ark', bailian: 'dashscope' };
const PRESETS = {
  anthropic: { protocol: 'anthropic', endpoint: 'https://api.anthropic.com' },
  openai: { protocol: 'openai', endpoint: 'https://api.openai.com/v1' },
  'openai-responses': { protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1' },
  dashscope: { protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  deepseek: { protocol: 'openai', endpoint: 'https://api.deepseek.com/v1' },
  google: { protocol: 'google', endpoint: 'https://generativelanguage.googleapis.com' },
  moonshot: { protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1' },
  minimax: { protocol: 'openai', endpoint: 'https://api.minimaxi.com/v1' },
  volc_ark: { protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  zhipu: { protocol: 'openai', endpoint: 'https://api.z.ai/api/paas/v4' },
  openrouter: { protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  ollama: { protocol: 'openai', endpoint: 'http://localhost:11434/v1' },
};
const PROTOCOLS = new Set(['openai', 'openai-responses', 'anthropic', 'google']);

function apiError(res, status, code, message, modelId = undefined) {
  return res.status(status).json({ code, message, ...(modelId ? { modelId } : {}) });
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
function retryPolicy(value) {
  const defaults = { maxRetries: 2, maxStreamRetries: 3, streamIdleTimeoutMs: 30000, baseDelayMs: 1000, maxDelayMs: 60000 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const parsed = Number(value[key] ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    output[key] = parsed;
  }
  if (output.baseDelayMs > output.maxDelayMs) return null;
  return output;
}
function resolveProvider(body) {
  const requested = text(body.providerId).toLowerCase();
  const providerId = ALIASES[requested] || requested;
  if (PRESETS[providerId]) return { providerId, ...PRESETS[providerId], custom: false };
  const protocol = text(body.protocol).toLowerCase();
  const endpoint = text(body.endpoint).replace(/\/+$/, '');
  try {
    const url = new URL(endpoint);
    if (!providerId || /\s/.test(providerId) || providerId === 'custom' || !PROTOCOLS.has(protocol) || !['http:', 'https:'].includes(url.protocol)) return null;
    return { providerId, protocol, endpoint: url.toString().replace(/\/$/, ''), custom: true };
  } catch { return null; }
}
function testStatus(models) {
  if (models.some((model) => model.textInput !== 'supported')) return 'failed';
  return models.some((model) => model.imageInput === 'unknown') ? 'manual_input_required' : 'passed';
}
function publicResult(record) {
  return { testId: record.id, status: record.status, manualInputRequired: record.status === 'manual_input_required', models: record.models, testedAt: record.testedAt, error: record.error || null };
}
function getTest(req, res, testId = req.params.testId) {
  const record = tests.get(testId);
  if (!record || record.userId !== req.user.id) { apiError(res, 404, 'TEST_NOT_FOUND', 'Connection test was not found.'); return null; }
  if (record.expiresAt <= Date.now()) { tests.delete(record.id); apiError(res, 410, 'TEST_EXPIRED', 'Connection test has expired.'); return null; }
  return record;
}
function deleteExpiredTests() { const now = Date.now(); for (const [id, record] of tests) if (record.expiresAt <= now) tests.delete(id); }
setInterval(deleteExpiredTests, TEST_TTL_MS).unref();

router.post('/model-connection-tests', async (req, res) => {
  const provider = resolveProvider(req.body || {});
  const requestedModels = Array.isArray(req.body?.models) ? req.body.models.map(text) : [];
  const models = [...new Set(requestedModels.filter(Boolean))];
  const retry = retryPolicy(req.body?.retryPolicy);
  const apiKey = text(req.body?.apiKey);
  if (!hasOnlyKeys(req.body, ['providerId', 'protocol', 'endpoint', 'apiKey', 'models', 'retryPolicy']) || !provider || !models.length || models.length !== requestedModels.length || !retry || (provider.providerId !== 'ollama' && !apiKey)) {
    return apiError(res, 400, 'INVALID_REQUEST', 'providerId, models, retryPolicy, and the required API key are invalid.');
  }
  const results = [];
  for (const modelId of models) {
    const textProbe = await probeModelConnection({ ...provider, apiKey, model: modelId });
    if (!textProbe.ok) {
      results.push({ modelId, textInput: 'unsupported', imageInput: 'unknown', error: { code: 'TEXT_TEST_FAILED', message: textProbe.error, modelId } });
      continue;
    }
    const imageProbe = await probeModelConnection({ ...provider, apiKey, model: modelId, image: true });
    results.push(imageProbe.ok
      ? { modelId, textInput: 'supported', imageInput: 'supported', error: null }
      : imageProbe.imageUnsupported
        ? { modelId, textInput: 'supported', imageInput: 'unsupported', error: null }
        : { modelId, textInput: 'supported', imageInput: 'unknown', error: { code: 'IMAGE_CAPABILITY_UNKNOWN', message: imageProbe.error, modelId } });
  }
  const record = { id: randomUUID(), userId: req.user.id, provider, retry, models: results, status: testStatus(results), testedAt: new Date().toISOString(), expiresAt: Date.now() + TEST_TTL_MS, error: null };
  tests.set(record.id, record);
  return res.json(publicResult(record));
});

router.put('/model-connection-tests/:testId/image-capabilities', (req, res) => {
  const record = getTest(req, res); if (!record) return;
  const supplied = Array.isArray(req.body?.models) ? req.body.models : [];
  const unknown = record.models.filter((model) => model.imageInput === 'unknown').map((model) => model.modelId).sort();
  const received = supplied.map((model) => text(model?.modelId)).sort();
  if (!hasOnlyKeys(req.body, ['models']) || !unknown.length || unknown.length !== received.length || unknown.some((id, index) => id !== received[index]) || supplied.some((model) => !hasOnlyKeys(model, ['modelId', 'imageInput']) || !['supported', 'unsupported'].includes(model?.imageInput))) {
    return apiError(res, 400, 'INVALID_REQUEST', 'models must provide exactly every unknown image capability.');
  }
  for (const model of record.models) {
    const suppliedModel = supplied.find((item) => item.modelId === model.modelId);
    if (suppliedModel) { model.imageInput = suppliedModel.imageInput; model.error = null; }
  }
  record.status = testStatus(record.models);
  return res.json(publicResult(record));
});

router.put('/model-configuration', async (req, res) => {
  const record = getTest(req, res, text(req.body?.testId)); if (!record) return;
  if (record.status !== 'passed') return apiError(res, 409, 'TEST_NOT_PASSED', 'Complete a passing connection test before saving.');
  const provider = resolveProvider(req.body || {});
  const retry = retryPolicy(req.body?.retryPolicy);
  const submittedModels = Array.isArray(req.body?.models) ? req.body.models : [];
  if (!hasOnlyKeys(req.body, ['testId', 'providerId', 'protocol', 'endpoint', 'apiKey', 'models', 'retryPolicy']) || !provider || !retry || provider.providerId !== record.provider.providerId || provider.protocol !== record.provider.protocol || provider.endpoint !== record.provider.endpoint || submittedModels.length !== record.models.length) {
    return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'Configuration does not match the tested provider and models.');
  }
  const expected = new Map(record.models.map((model) => [model.modelId, model]));
  for (const submitted of submittedModels) {
    const tested = expected.get(text(submitted?.modelId));
    if (!hasOnlyKeys(submitted, ['modelId', 'textInput', 'imageInput']) || !tested || submitted.textInput !== true || submitted.imageInput !== (tested.imageInput === 'supported')) return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'Model capabilities do not match the connection test.');
  }
  const recordConfig = readPilotDeckConfigFile();
  if (recordConfig.parseError) return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'pilotdeck.yaml is invalid and must be repaired before saving.');
  const existingProvider = recordConfig.config?.model?.providers?.[provider.providerId] || {};
  const suppliedKey = req.body?.apiKey;
  const apiKey = typeof suppliedKey === 'string' && suppliedKey.trim() ? suppliedKey.trim() : existingProvider.apiKey;
  if (provider.providerId !== 'ollama' && !apiKey) return apiError(res, 400, 'INVALID_REQUEST', 'apiKey is required for this provider.');
  const configurationId = `cfg_${randomUUID()}`;
  const modelsConfig = Object.fromEntries(record.models.map((model) => [model.modelId, { multimodal: { input: model.imageInput === 'supported' ? ['text', 'image'] : ['text'] } }]));
  const nextConfig = {
    ...recordConfig.config,
    agent: { ...recordConfig.config.agent, model: `${provider.providerId}/${record.models[0].modelId}` },
    model: { ...recordConfig.config.model, providers: { ...recordConfig.config.model.providers, [provider.providerId]: {
      ...existingProvider, protocol: provider.protocol, url: provider.endpoint, ...(apiKey ? { apiKey } : {}),
      retry: { requestMaxRetries: retry.maxRetries, streamMaxRetries: retry.maxStreamRetries, streamIdleTimeoutMs: retry.streamIdleTimeoutMs, baseDelayMs: retry.baseDelayMs, maxDelayMs: retry.maxDelayMs }, models: modelsConfig,
    } } },
    webui: { ...recordConfig.config.webui, onboarding: { modelConfigurationId: configurationId, savedAt: new Date().toISOString() } },
  };
  try {
    suppressNextWatchEvent();
    const saved = await writePilotDeckConfig(nextConfig);
    await reloadPilotDeckConfig(saved.config);
    tests.delete(record.id);
    return res.json({ configurationId, savedAt: saved.config.webui.onboarding.savedAt });
  } catch (error) {
    return apiError(res, 409, 'CONFIGURATION_MISMATCH', error?.message || 'Unable to save configuration.');
  }
});

router.post('/workspaces', async (req, res) => {
  const type = text(req.body?.type);
  const requestedPath = text(req.body?.path);
  if (!hasOnlyKeys(req.body, ['type', 'path', 'githubUrl', 'modelConfigurationId']) || !['existing', 'new'].includes(type) || !requestedPath) return apiError(res, 400, 'INVALID_REQUEST', 'type and path are required.');
  if (req.body?.modelConfigurationId) {
    const configId = readPilotDeckConfigFile().config?.webui?.onboarding?.modelConfigurationId;
    if (req.body.modelConfigurationId !== configId) return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'modelConfigurationId is not the active configuration.');
  }
  const validation = await validateWorkspacePath(requestedPath);
  if (!validation.valid) return apiError(res, 400, 'PATH_NOT_WRITABLE', validation.error || 'Invalid workspace path.');
  const workspacePath = validation.resolvedPath;
  try {
    if (type === 'existing') {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) return apiError(res, 400, 'PATH_NOT_FOUND', 'Workspace path is not a directory.');
      const project = await addProjectManually(workspacePath);
      return res.status(201).json({ id: project.name, type, path: workspacePath, status: 'ready' });
    }
    await fs.mkdir(workspacePath, { recursive: true });
    let projectPath = workspacePath;
    const githubUrl = text(req.body?.githubUrl);
    if (githubUrl) {
      let parsed; try { parsed = new URL(githubUrl); } catch { return apiError(res, 400, 'INVALID_REQUEST', 'githubUrl must be an absolute URL.'); }
      const repoName = path.basename(parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '')) || 'repository';
      projectPath = path.join(workspacePath, repoName);
      try { await fs.access(projectPath); return apiError(res, 409, 'WORKSPACE_CONFLICT', 'Clone destination already exists.'); } catch { /* expected */ }
      try { await cloneGitHubRepository(githubUrl, projectPath); } catch (error) { return apiError(res, 409, 'GIT_CLONE_FAILED', 'Unable to clone the repository.'); }
    }
    const project = await addProjectManually(projectPath);
    return res.status(201).json({ id: project.name, type, path: projectPath, status: 'ready' });
  } catch (error) {
    if (error?.code === 'ENOENT') return apiError(res, 404, 'PATH_NOT_FOUND', 'Workspace path does not exist.');
    return apiError(res, 409, 'WORKSPACE_CONFLICT', error?.message || 'Unable to create workspace.');
  }
});

export { TEST_TTL_MS, tests };
export default router;
