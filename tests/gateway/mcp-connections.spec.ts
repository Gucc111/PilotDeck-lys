import assert from 'node:assert/strict';
import test from 'node:test';
import { McpSchedulingError } from '../../src/mcp/runtime/McpConnectionManager.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { GatewayWsClient } from '../../src/gateway/client/GatewayWsClient.js';
import { RemoteGateway } from '../../src/gateway/client/RemoteGateway.js';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelRequest, type CanonicalModelEvent } from '../../src/model/index.js';

async function fixture(t: test.TestContext, mode = 'normal', policy = { connection: 'shared', usage: 'serial' }) {
  const home = await mkdtemp(join(tmpdir(), 'gateway-mcp-')), log = join(home, 'server.jsonl'); await mkdir(join(home, 'skills'));
  await writeFile(join(home, 'pilotdeck.yaml'), 'schemaVersion: 1\nagent: { model: test/test }\nmodel: { providers: { test: { protocol: openai, url: https://example.test/v1, apiKey: test, models: { test: {} } } } }\nmemory: { enabled: false }\ntelemetry: { enabled: false }\nextension: { builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false } }\n');
  await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { managed: { command: process.execPath, args: [resolve('tests/mcp/fixtures/managed-server.mjs'), log, mode], ...policy } } }));
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: undefined }, __testModelFactory: snapshot => ({ ...createModelRuntime(snapshot.config.model), async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    requests.push(request); yield { type: 'request_started', provider: request.provider, model: request.model }; yield { type: 'message_start', role: 'assistant' };
    if (!request.messages.some(message => message.role === 'assistant')) {
      yield { type: 'tool_call_start', id: 'step', name: 'mcp__managed__step' };
      yield { type: 'tool_call_end', toolCall: { id: 'step', name: 'mcp__managed__step', input: {} } };
    } else yield { type: 'text_delta', text: 'done' };
    yield { type: 'message_end', finishReason: 'stop' };
  } }) });
  t.after(async () => { await local.dispose(); await rm(home, { recursive: true, force: true }); });
  const submit = async (sessionKey: string) => { const events = []; for await (const event of local.gateway.submitTurn({ sessionKey, channelKey: 'test', projectKey: home, message: 'use managed tool', basePermissionMode: 'bypassPermissions' })) events.push(event); return events; };
  const evidence = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { ...local, home, requests, submit, evidence };
}

test('real Gateway + stdio: two chats share one handshake and final model tools include every page', async t => {
  const f = await fixture(t); const [a, b] = await Promise.all([f.submit('chat-a'), f.submit('chat-b')]);
  assert.deepEqual([...a, ...b].filter(event => event.type === 'error'), []);
  const evidence = await f.evidence(); assert.equal(evidence.filter(row => row.event === 'spawn').length, 1);
  assert.equal(evidence.filter(row => row.event === 'call_start').length, 2);
  let active = 0; for (const row of evidence) { if (row.event === 'call_start') active++; if (row.event === 'call_end') active--; assert.ok(active <= 1); }
  for (const request of f.requests) for (const name of ['mcp__managed__step', 'mcp__managed__read']) assert.ok(request.tools?.some(tool => tool.name === name));
  assert.ok(a.some(event => event.type === 'mcp_status'));
  await f.gateway.mcpManage!({ action: 'release', owner: { sessionKey: 'chat-a' } });
  assert.equal((await f.gateway.mcpManage!({ action: 'status' })).statuses.filter(status => status.state === 'ready').length, 1);
  await f.submit('chat-a'); assert.equal((await f.evidence()).filter(row => row.event === 'spawn').length, 1);
});

for (const mode of ['fail', 'collision']) test(`real Gateway + stdio: ${mode} blocks the model rather than silently omitting tools`, async t => {
  const f = await fixture(t, mode); const events = await f.submit('chat'); assert.ok(events.some(event => event.type === 'error'));
  assert.equal(f.requests.length, 0); assert.ok((await f.gateway.mcpManage!({ action: 'status' })).statuses.some(status => status.state === 'failed'));
});


test('real WebSocket RPC exposes capacity waits, cancellation and idle release', async t => {
  const f = await fixture(t, 'normal', { connection: 'separate', usage: 'concurrent', maxConnections: 1 } as any);
  const server = await startGatewayServer({ gateway: f.gateway, port: 0, token: 'isolated-mcp-test' });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: 'test' });
  t.after(async () => { client.close(); await server.close(); });
  await client.connect(); const remote = new RemoteGateway(client);
  await f.submit('holder'); const waiting = f.submit('waiting');
  let state;
  for (let i = 0; i < 200; i++) {
    state = await remote.mcpManage({ action: 'status' });
    if (state.statuses.some(status => status.state === 'waiting_capacity')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(state!.statuses.some(status => status.state === 'waiting_capacity' && status.holders.some(holder => holder.sessionKey === 'holder')));
  assert.equal((await f.evidence()).filter(row => row.event === 'spawn').length, 1);
  await remote.mcpManage({ action: 'cancel', owner: { sessionKey: 'waiting' } });
  assert.ok((await waiting).some(event => event.type === 'error'));
  await remote.mcpManage({ action: 'release', owner: { sessionKey: 'holder' } });
  await f.submit('waiting'); assert.equal((await f.evidence()).filter(row => row.event === 'spawn').length, 2);
});


test('cancelling an idle cached owner recreates its lease at the next execution', async t => {
  const f = await fixture(t);
  await f.submit('cached');
  await f.gateway.mcpManage!({ action: 'cancel', owner: { sessionKey: 'cached' } });
  const events = await f.submit('cached');
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.ok((await f.gateway.mcpManage!({ action: 'status' })).statuses.some(status => status.owner?.sessionKey === 'cached' && status.state === 'ready'));
});


test('Gateway preserves retryability of MCP scheduling timeouts during preparation', async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => { throw new McpSchedulingError('mcp_wait_timeout', 'MCP connection wait timed out'); } });
  const gateway = new InProcessGateway(router);
  const events = [];
  for await (const event of gateway.submitTurn({ sessionKey: 'timed-out', channelKey: 'test', message: 'use MCP' })) events.push(event);
  assert.ok(events.some(event => event.type === 'error' && event.code === 'mcp_wait_timeout' && event.recoverable));
  await router.close('timed-out');
});
