import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelRequest, type CanonicalModelEvent } from '../../src/model/index.js';
import { McpConnectionManager } from '../../src/mcp/runtime/McpConnectionManager.js';

for (const deleteStatus of [200, 405, 500]) test(`real HTTP shared session, pagination, call and DELETE=${deleteStatus}`, async t => {
  let handshakes = 0, deletes = 0, lists = 0, calls = 0;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    try {
      let body: any; if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; body = JSON.parse(text); }
      const id = req.headers['mcp-session-id'] as string | undefined;
      let transport = id ? sessions.get(id) : undefined;
      if (req.method === 'DELETE') { deletes++; if (deleteStatus !== 200) { res.writeHead(deleteStatus).end(); return; } }
      if (!transport && body?.method === 'initialize') {
        handshakes++;
        const server = new Server({ name: 'http-test', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async request => { lists++; return { tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }], ...(!request.params?.cursor ? { nextCursor: 'next' } : {}) }; });
        server.setRequestHandler(CallToolRequestSchema, async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; });
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sid => { sessions.set(sid, transport!); } });
        await server.connect(transport);
      }
      if (!transport) { res.writeHead(404).end(); return; }
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const manager = new McpConnectionManager();
  t.after(async () => { await manager.close(); for (const transport of sessions.values()) await transport.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address() as { port: number };
  const config = { id: 'http', transport: 'streamable_http' as const, url: `http://127.0.0.1:${address.port}/mcp`, connection: 'shared' as const };
  const a = await manager.acquire({ sessionKey: 'chat' }, [config]), b = await manager.acquire({ sessionKey: 'team' }, [config]);
  assert.equal(handshakes, 1); assert.equal(lists, 2); assert.equal((await a.listAllTools()).length, 2);
  await b.getClient('http')!.callTool('first', {}); assert.equal(calls, 1);
  await b.stop(); assert.equal(deletes, 0); await a.stop(); assert.equal(deletes, 1);
  assert.equal(manager.snapshot().some(status => status.stage === 'cleanup' && status.state === 'failed'), deleteStatus !== 200);
  if (deleteStatus === 200) {
    const home = await mkdtemp(join(tmpdir(), 'gateway-http-mcp-')); await mkdir(join(home, 'skills'));
    await writeFile(join(home, 'pilotdeck.yaml'), JSON.stringify({ schemaVersion: 1, agent: { model: 'test/test' }, model: { providers: { test: { protocol: 'openai', url: 'https://example.test/v1', apiKey: 'test', models: { test: {} } } } }, memory: { enabled: false }, telemetry: { enabled: false }, extension: { builtinPluginsEnabled: { 'windows-skills': false, 'browser-use': false, funasr: false } } }));
    await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { http: { url: config.url, connection: 'shared', usage: 'serial' } } }));
    const requests: CanonicalModelRequest[] = [];
    const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: undefined }, __testModelFactory: snapshot => ({ ...createModelRuntime(snapshot.config.model), async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request); yield { type: 'request_started', provider: request.provider, model: request.model }; yield { type: 'message_start', role: 'assistant' };
      if (!request.messages.some(message => message.role === 'assistant')) {
        yield { type: 'tool_call_start', id: 'read', name: 'mcp__http__first' }; yield { type: 'tool_call_end', toolCall: { id: 'read', name: 'mcp__http__first', input: {} } };
      } else yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', finishReason: 'stop' };
    } }) });
    try {
      const submit = async (sessionKey: string) => { const events = []; for await (const event of local.gateway.submitTurn({ sessionKey, projectKey: home, channelKey: 'test', message: 'read', basePermissionMode: 'bypassPermissions' })) events.push(event); return events; };
      const events = (await Promise.all([submit('http-chat-a'), submit('http-chat-b')])).flat();
      assert.deepEqual(events.filter(event => event.type === 'error'), []);
      assert.equal(handshakes, 2); assert.equal(calls, 3);
      assert.ok(requests.every(request => ['mcp__http__first', 'mcp__http__second'].every(name => request.tools?.some(tool => tool.name === name))));
      assert.ok(events.some(event => event.type === 'mcp_status'));
    } finally { await local.dispose(); await rm(home, { recursive: true, force: true }); }
    assert.equal(deletes, 2);
  }

});
