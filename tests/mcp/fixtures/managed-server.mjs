import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const [log, mode = 'normal'] = process.argv.slice(2);
const record = event => appendFileSync(log, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + '\n');
record('spawn');
const server = new Server({ name: 'managed-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async request => {
  record('list');
  if (mode === 'fail') throw new Error('Fixture discovery failure');
  const name = request.params?.cursor ? (mode === 'collision' ? 'step' : 'read') : 'step';
  return { tools: [{ name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], ...(!request.params?.cursor ? { nextCursor: 'page2' } : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async () => {
  record('call_start'); await new Promise(resolve => setTimeout(resolve, 50)); record('call_end');
  return { content: [{ type: 'text', text: 'managed result' }] };
});
process.on('exit', () => record('exit'));
await server.connect(new StdioServerTransport()); record('connected');
