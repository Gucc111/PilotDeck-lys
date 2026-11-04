import assert from 'node:assert/strict';
import test from 'node:test';
import { McpConnectionManager, mcpResourceId, type ManagedMcpClient, type McpOwner } from '../../../src/mcp/runtime/McpConnectionManager.js';
import type { PilotDeckMcpServerSpec, PilotDeckMcpToolSpec } from '../../../src/mcp/protocol/types.js';

function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const owner = (sessionKey: string): McpOwner => ({ sessionKey });
const spec = (patch: Partial<PilotDeckMcpServerSpec> = {}): PilotDeckMcpServerSpec => ({ id: 'db', transport: 'stdio', command: 'fake', ...patch } as PilotDeckMcpServerSpec);
function harness(options: { waitTimeoutMs?: number; start?: () => Promise<void>; close?: () => Promise<void>; tools?: (spec: PilotDeckMcpServerSpec) => Promise<PilotDeckMcpToolSpec[]>; call?: (signal?: AbortSignal) => Promise<any> } = {}) {
  const clients: Array<ManagedMcpClient & { calls: number; closes: number }> = [];
  const manager = new McpConnectionManager({ waitTimeoutMs: options.waitTimeoutMs, createClient: config => {
    const client = { spec: config, calls: 0, closes: 0, start: options.start ?? (async () => {}), listTools: async () => options.tools ? options.tools(config) : [], getInstructions: () => '', close: async () => { client.closes++; await options.close?.(); }, callTool: async (_tool: string, _args: unknown, opts?: { signal?: AbortSignal }) => { client.calls++; return options.call?.(opts?.signal) ?? { content: [] }; } };
    clients.push(client); return client;
  } });
  return { manager, clients };
}

for (const connection of ['shared', 'separate'] as const) for (const usage of ['serial', 'concurrent'] as const) {
  test(`${connection}/${usage}: physical clients and cross-owner call overlap`, async () => {
    const gates = [deferred<any>(), deferred<any>()]; let active = 0, peak = 0, calls = 0;
    const { manager, clients } = harness({ call: async () => { const index = calls++; active++; peak = Math.max(peak, active); try { return await gates[index]!.promise; } finally { active--; } } });
    await Promise.all([manager.acquire(owner('chat'), [spec({ connection, usage })]), manager.acquire(owner('member'), [spec({ connection, usage })])]);
    assert.equal(clients.length, connection === 'shared' ? 1 : 2);
    const a = manager.call(owner('chat'), 'db', 'read', {}), b = manager.call(owner('member'), 'db', 'read', {});
    await tick(); assert.equal(calls, usage === 'serial' ? 1 : 2);
    gates[0]!.resolve({ content: [] }); await a; await tick(); gates[1]!.resolve({ content: [] }); await b;
    assert.equal(peak, usage === 'serial' ? 1 : 2); await manager.close();
  });
}

test('shared handshakes coalesce; Team release does not close the ordinary chat reference', async () => {
  const gate = deferred(), { manager, clients } = harness({ start: () => gate.promise });
  const chat = owner('chat'), member = { sessionKey: 'member', activationId: 'team', participantId: 'a', stopVersion: 0 };
  const a = manager.acquire(chat, [spec({ connection: 'shared' })]), b = manager.acquire(member, [spec({ connection: 'shared' })]);
  await tick(); assert.equal(clients.length, 1);
  assert.equal(manager.snapshot().filter(status => status.state === 'connecting').length, 2);
  assert.ok(manager.snapshot().some(status => status.owner?.sessionKey === 'member' && status.state === 'connecting'));
  gate.resolve(); await Promise.all([a, b]);
  assert.equal(manager.snapshot().filter(status => status.state === 'ready').length, 2);
  manager.cancel(member); await manager.release(member); assert.equal(clients[0]!.closes, 0);
  await manager.call(chat, 'db', 'read', {}); await manager.release(chat); assert.equal(clients[0]!.closes, 1);
});

test('resource identity includes credentials, cwd and server ID but excludes scheduling policy', () => {
  const base = spec(); assert.notEqual(mcpResourceId(base), mcpResourceId(spec({ cwd: '/other' })));
  assert.notEqual(mcpResourceId(base), mcpResourceId(spec({ env: { TOKEN: 'secret' } } as any)));
  assert.notEqual(mcpResourceId(base), mcpResourceId(spec({ id: 'other' })));
  assert.equal(mcpResourceId(base), mcpResourceId(spec({ usage: 'serial', connection: 'shared', maxConnections: 1 })));
});

test('atomic multi-MCP reservation never holds a free slot while waiting for another resource', async () => {
  const { manager, clients } = harness(); const x = spec({ id: 'x', maxConnections: 1 }), y = spec({ id: 'y', maxConnections: 1 });
  await manager.acquire(owner('a'), [x]); const abort = new AbortController();
  const waiting = manager.acquire(owner('b'), [y, x], abort.signal); const rejected = assert.rejects(waiting);
  await tick(); assert.equal(clients.length, 1);
  await manager.acquire(owner('c'), [y]); assert.equal(clients.length, 2);
  abort.abort(); await rejected; await manager.close();
});

test('120 second capacity timeout uses a controllable clock and preserves the idle holder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, clients } = harness(); const limited = spec({ maxConnections: 1 });
  await manager.acquire(owner('a'), [limited]);
  const rejected = assert.rejects(manager.acquire(owner('b'), [limited]), { code: 'mcp_wait_timeout' });
  t.mock.timers.tick(120_000); await rejected;
  assert.equal(clients.length, 1); assert.equal(clients[0]!.closes, 0); await manager.close();
});

test('closing clients count towards capacity until transport cleanup completes', async () => {
  const close = deferred(), { manager, clients } = harness({ close: () => close.promise });
  const limited = spec({ maxConnections: 1 }); await manager.acquire(owner('a'), [limited]);
  const release = manager.release(owner('a')); const acquiring = manager.acquire(owner('b'), [limited]);
  await tick(); assert.equal(clients.length, 1); close.resolve(); await release; await acquiring; assert.equal(clients.length, 2); await manager.close();
});

test('conflicting scheduling versions drain old references before starting the new policy', async () => {
  const { manager, clients } = harness(); await manager.acquire(owner('a'), [spec({ connection: 'shared' })]);
  const next = manager.acquire(owner('b'), [spec({ connection: 'shared', usage: 'serial' })]);
  await tick(); assert.equal(clients.length, 1); await manager.release(owner('a')); await next; assert.equal(clients.length, 2); await manager.close();
});

test('serial FIFO survives middle-waiter cancellation and locks do not cover multiple calls', async () => {
  const gate = deferred<any>(); let n = 0;
  const { manager, clients } = harness({ call: async () => ++n === 1 ? gate.promise : { content: [] } });
  for (const id of ['a', 'b', 'c']) await manager.acquire(owner(id), [spec({ usage: 'serial' })]);
  const a = manager.call(owner('a'), 'db', 'step1', {}); await tick();
  const abort = new AbortController(), b = manager.call(owner('b'), 'db', 'step1', {}, { signal: abort.signal });
  const rejected = assert.rejects(b); const c = manager.call(owner('c'), 'db', 'step1', {}); abort.abort(); await rejected;
  assert.equal(clients[2]!.calls, 0); gate.resolve({ content: [] }); await Promise.all([a, c]);
  await manager.call(owner('a'), 'db', 'step2', {}); assert.equal(clients[2]!.calls, 1); await manager.close();
});

test('uncertain serial execution quarantines resource until explicit reset, including after all references close', async () => {
  const { manager } = harness({ call: async () => { throw Object.assign(new Error('timeout'), { code: 'mcp_call_timeout' }); } });
  const serial = spec({ usage: 'serial' }); await manager.acquire(owner('a'), [serial]);
  await assert.rejects(manager.call(owner('a'), 'db', 'write', {}), { code: 'mcp_call_timeout' });
  await manager.release(owner('a')); await manager.acquire(owner('b'), [serial]);
  await assert.rejects(manager.call(owner('b'), 'db', 'write', {}), { code: 'mcp_execution_unknown' });
  manager.reset(mcpResourceId(serial)); await assert.rejects(manager.call(owner('b'), 'db', 'write', {}), { code: 'mcp_call_timeout' }); await manager.close();
});

test('failed shared discovery rolls back all new references and closes only once', async () => {
  const gate = deferred<PilotDeckMcpToolSpec[]>(), { manager, clients } = harness({ tools: () => gate.promise });
  const a = manager.acquire(owner('a'), [spec({ connection: 'shared' })]), b = manager.acquire(owner('b'), [spec({ connection: 'shared' })]);
  const results = Promise.allSettled([a, b]); await tick(); gate.reject(new Error('discovery failed')); assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(clients[0]!.closes, 1); assert.deepEqual(manager.ownerList(), []); await manager.close();
});

test('cancelled initialization returns promptly but retains physical capacity until cleanup', async () => {
  const gate = deferred(), { manager, clients } = harness({ start: () => gate.promise }); const abort = new AbortController();
  const acquiring = manager.acquire(owner('a'), [spec({ maxConnections: 1 })], abort.signal); const rejected = assert.rejects(acquiring);
  await tick(); abort.abort(); await rejected; assert.equal(clients[0]!.closes, 0);
  gate.resolve(); await tick(); assert.equal(clients[0]!.closes, 1); await manager.close();
});

test('empty tools are valid, optional discovery degrades explicitly, mandatory discovery blocks', async () => {
  const { manager } = harness({ tools: async config => { if (config.id === 'bad') throw new Error('tools unavailable'); return []; } });
  const lease = await manager.acquire(owner('a'), [spec(), spec({ id: 'bad' })], undefined, new Set(['bad']));
  assert.deepEqual(await lease.listAllTools(), []); assert.deepEqual(lease.missing, ['bad']);
  await assert.rejects(manager.acquire(owner('b'), [spec({ id: 'bad' })])); await manager.close();
});

test('duplicate batch IDs and concurrent same-owner preparation are rejected', async () => {
  const gate = deferred(), { manager } = harness({ start: () => gate.promise });
  await assert.rejects(manager.acquire(owner('a'), [spec(), spec()]));
  const first = manager.acquire(owner('a'), [spec()]); await assert.rejects(manager.acquire(owner('a'), [spec()])); gate.resolve(); await first; await manager.close();
});


test('serial queue timeout has its own 120 second budget and does not release the running call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = deferred<any>(); let calls = 0;
  const { manager } = harness({ call: async () => ++calls === 1 ? gate.promise : { content: [] } });
  await manager.acquire(owner('a'), [spec({ usage: 'serial' })]);
  await manager.acquire(owner('b'), [spec({ usage: 'serial' })]);
  const running = manager.call(owner('a'), 'db', 'write', {});
  await Promise.resolve(); await Promise.resolve();
  const rejected = assert.rejects(manager.call(owner('b'), 'db', 'write', {}), { code: 'mcp_wait_timeout' });
  t.mock.timers.tick(120_000); await rejected; assert.equal(calls, 1);
  gate.resolve({ content: [] }); await running;
  await manager.call(owner('b'), 'db', 'write', {}); assert.equal(calls, 2); await manager.close();
});

test('unknown serial execution remains visible when another owner acquires the same resource', async () => {
  const { manager } = harness({ call: async () => { throw new Error('raw transport failure'); } });
  const config = spec({ usage: 'serial', connection: 'shared' });
  await manager.acquire(owner('a'), [config]);
  await assert.rejects(manager.call(owner('a'), 'db', 'write', {}));
  await manager.acquire(owner('b'), [config]);
  assert.ok(manager.snapshot().filter(status => status.owner).every(status => status.state === 'unknown'));
  await assert.rejects(manager.call(owner('b'), 'db', 'write', {}), { code: 'mcp_execution_unknown' }); await manager.close();
});

test('release acknowledges a failed preparation after its owner has already been cleaned up', async () => {
  const { manager } = harness({ tools: async () => { throw new Error('discovery failed'); } });
  await assert.rejects(manager.acquire(owner('failed'), [spec()]));
  assert.equal(manager.ownerList().length, 0); assert.equal(manager.snapshot().length, 1);
  await manager.release(owner('failed'), true); assert.deepEqual(manager.snapshot(), []);
  manager.reportUnavailable(owner('optional'), 'missing');
  assert.ok(manager.snapshot().some(status => status.serverId === 'missing' && status.stage === 'connect'));
  await manager.release(owner('optional')); assert.deepEqual(manager.snapshot(), []); await manager.close();
});

test('cleanup failure retains its physical capacity until a successful close retry', async () => {
  const { manager, clients } = harness();
  const config = spec({ maxConnections: 1 }); await manager.acquire(owner('a'), [config]);
  let attempts = 0; clients[0]!.close = async () => { if (++attempts === 1) throw new Error('close failed'); };
  await assert.rejects(manager.release(owner('a')));
  const abort = new AbortController(), waiting = manager.acquire(owner('b'), [config], abort.signal);
  const rejected = assert.rejects(waiting); await tick(); assert.equal(clients.length, 1);
  abort.abort(); await rejected; await manager.release(owner('a')); assert.equal(attempts, 2); await manager.close();
});

test('shared acquire cannot reuse a transport whose local close failed', async () => {
  const { manager, clients } = harness(); const config = spec({ connection: 'shared' });
  await manager.acquire(owner('a'), [config]); let attempts = 0;
  clients[0]!.close = async () => { if (++attempts === 1) throw new Error('close failed'); };
  await assert.rejects(manager.release(owner('a')));
  const waiting = manager.acquire(owner('b'), [config]); await tick();
  assert.ok(manager.snapshot().some(status => status.owner?.sessionKey === 'b' && status.state === 'waiting_capacity'));
  await manager.release(owner('a')); await waiting; assert.equal(clients.length, 2); await manager.close();
});

test('a recovered client requires tool snapshot refresh before dispatch', async () => {
  const { manager, clients } = harness(); const config = spec({ connection: 'shared' });
  await manager.acquire(owner('a'), [config]);
  let generation = 1;
  (clients[0] as any).getGeneration = () => generation;
  await manager.refresh(owner('a'));
  generation = 2;
  await assert.rejects(manager.call(owner('a'), 'db', 'read', {}), { code: 'mcp_capabilities_changed' });
  assert.equal(clients[0]!.calls, 0);
  await manager.refresh(owner('a')); await manager.call(owner('a'), 'db', 'read', {});
  assert.equal(clients[0]!.calls, 1); await manager.close();
});
