import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'team-mcp-cleanup-'));
  await mkdir(join(home, 'skills'));
  await writeFile(join(home, 'pilotdeck.yaml'), 'schemaVersion: 1\nagent: { model: test/test }\nmodel: { providers: { test: { protocol: openai, url: https://example.test/v1, apiKey: test, models: { test: {} } } } }\nmemory: { enabled: false }\ntelemetry: { enabled: false }\nextension: { builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false } }\n');
  const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: undefined } });
  t.after(async () => { await local.dispose(); await rm(home, { recursive: true, force: true }); });
  const internals = local.registry as unknown as { sessionMcpRuntimes: Map<string, { stop: () => Promise<void> }> };
  return { local, ...internals };
}

test('concurrent session eviction and disposal wait for the same actual MCP close', async t => {
  const { local, sessionMcpRuntimes } = await fixture(t), close = deferred(); let calls = 0;
  sessionMcpRuntimes.set('team-member', { stop: async () => { calls++; await close.promise; } });
  const first = local.registry.evictSessionMcp('team-member'), duplicate = local.registry.evictSessionMcp('team-member');
  assert.equal(first, duplicate);
  let disposed = false;
  const disposing = local.registry.dispose().then(() => { disposed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(disposed, false); assert.equal(sessionMcpRuntimes.has('team-member'), true);
  close.resolve(); await Promise.all([first, duplicate, disposing]);
  assert.equal(disposed, true); assert.equal(sessionMcpRuntimes.has('team-member'), false);
});

test('MCP close failures remain retryable instead of being reported as successful cleanup', async t => {
  const { local, sessionMcpRuntimes } = await fixture(t); let attempts = 0;
  sessionMcpRuntimes.set('team-leader', { stop: async () => { if (++attempts === 1) throw new Error('close failed'); } });
  await assert.rejects(local.registry.evictSessionMcp('team-leader'), /close failed/);
  assert.equal(sessionMcpRuntimes.has('team-leader'), true);
  await local.registry.evictSessionMcp('team-leader');
  assert.equal(attempts, 2); assert.equal(sessionMcpRuntimes.has('team-leader'), false);
});

test('team cleanup awaits all of its members, retains failed cleanup for retry, and leaves other teams alone', async t => {
  const { local, sessionMcpRuntimes } = await fixture(t), slow = deferred(); let attempts = 0, otherCalls = 0;
  sessionMcpRuntimes.set('team-internal:activation:a', { stop: async () => { await slow.promise; } });
  sessionMcpRuntimes.set('team-internal:activation:b', { stop: async () => { if (++attempts === 1) throw new Error('member close failed'); } });
  sessionMcpRuntimes.set('team-internal:other:member', { stop: async () => { otherCalls++; } });
  await assert.rejects(local.registry.awaitTeamMcpCleanup('activation'), /member close failed/);
  assert.equal(sessionMcpRuntimes.has('team-internal:activation:b'), true); assert.equal(otherCalls, 0);
  let complete = false;
  const retry = local.registry.awaitTeamMcpCleanup('activation').then(() => { complete = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(complete, false);
  slow.resolve(); await retry;
  assert.equal(attempts, 2); assert.equal(complete, true); assert.equal(otherCalls, 0);
  assert.equal(sessionMcpRuntimes.has('team-internal:activation:a'), false);
  assert.equal(sessionMcpRuntimes.has('team-internal:activation:b'), false);
});
