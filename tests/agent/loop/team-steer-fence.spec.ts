import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop, type AgentLoopRunResult } from '../../../src/agent/loop/AgentLoop.js';
import type { AgentRouterRuntime } from '../../../src/agent/runtime/AgentRuntimeDependencies.js';
import { AgentSession } from '../../../src/agent/session/AgentSession.js';
import { TurnRunner } from '../../../src/agent/turn/TurnRunner.js';
import { InMemoryTranscriptWriter } from '../../../src/session/transcript/InMemoryTranscriptWriter.js';
import type { AgentSteerMessage } from '../../../src/agent/session/SteerMailbox.js';
import type { AgentEvent } from '../../../src/agent/protocol/events.js';
import type { CanonicalMessage, CanonicalModelRequest, CanonicalModelEvent } from '../../../src/model/index.js';
import { createDefaultPermissionContext } from '../../../src/permission/index.js';
import { ToolRegistry } from '../../../src/tool/index.js';
import { TeamMessageDelivery } from '../../../src/team/TeamMessageDelivery.js';

function fixture(options: { respond?: (request: CanonicalModelRequest, index: number) => AsyncIterable<CanonicalModelEvent>; onTools?: () => Promise<void> } = {}) {
  const requests: CanonicalModelRequest[] = [];
  const respond = async function* (request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    requests.push(request);
    if (options.respond) { yield* options.respond(request, requests.length); return; }
    yield { type: 'request_started', provider: 'test', model: 'controlled' };
    yield { type: 'message_start', role: 'assistant' }; yield { type: 'text_delta', text: 'answer' }; yield { type: 'message_end', finishReason: 'stop' };
  };
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: 'default', isSubagent: false, orchestrating: false, resolvedFrom: 'explicit', mutations: {} }),
    execute: (_, request) => respond(request), stream: request => respond(request),
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }), observeUsage: () => undefined,
  };
  const registry = new ToolRegistry();
  registry.register({ name: 'controlled_tool', description: 'Controlled test tool', kind: 'custom', inputSchema: { type: 'object', properties: {} }, isReadOnly: () => true, isConcurrencySafe: () => true, execute: async () => ({ content: [{ type: 'text', text: 'done' }] }) });
  const loop = new AgentLoop({ provider: 'test', model: 'controlled', cwd: '/workspace', permissionMode: 'default', permissionContext: createDefaultPermissionContext({ cwd: '/workspace', mode: 'default', canPrompt: false, bypassAvailable: true }) }, { router, tools: { registry, scheduler: { executeAll: async calls => { await options.onTools?.(); return calls.map(call => ({ type: 'success' as const, toolCallId: call.id, toolName: call.name, content: [{ type: 'text' as const, text: 'tool completed' }], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })); } } } });
  return { requests, loop };
}
const message: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'internal Team event' }], metadata: { synthetic: true, purpose: 'team_runtime', queueItemId: 'event-1' } };
const steer = (beforeApply?: () => Promise<boolean>): AgentSteerMessage => ({ itemId: 'event-1', message, allowedReadFiles: ['/private/member.txt'], beforeApply });
function drainOnce(value: AgentSteerMessage) { let done = false; return () => { if (done) return []; done = true; return [value]; }; }
async function collect(iterator: AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown>) {
  const events: AgentEvent[] = [];
  while (true) { const next = await iterator.next(); if (next.done) return { events, result: next.value }; events.push(next.value); }
}

test('invalidated Team steer is not persisted, granted file access, or added to the next model request', async () => {
  const f = fixture(), durable: CanonicalMessage[] = [];
  const run = await collect(f.loop.run({ sessionId: 's', turnId: 't', messages: [], drainSteerMessages: drainOnce(steer(async () => false)), onDurableMessage: msg => { durable.push(msg); } }));
  assert.equal(f.requests.length, 1); assert.equal(durable.includes(message), false);
  assert.equal(f.requests[0]!.messages.includes(message), false); assert.deepEqual(f.loop.snapshotFileState().allowedReadFiles, []);
  assert.equal(run.events.filter(event => event.type === 'steer_unapplied').length, 1); assert.equal(run.events.filter(event => event.type === 'steer_applied').length, 0);
});

test('abort while awaiting the generation fence prevents the durable append itself', async () => {
  const f = fixture(), controller = new AbortController(), durable: CanonicalMessage[] = [];
  const run = await collect(f.loop.run({ sessionId: 's', turnId: 't', messages: [], abortSignal: controller.signal,
    drainSteerMessages: drainOnce(steer(async () => { await Promise.resolve(); controller.abort('team_stopped'); return true; })),
    onDurableMessage: msg => { durable.push(msg); },
  }));
  assert.equal(durable.includes(message), false); assert.equal(f.requests.length, 0); assert.equal(run.result.result.type, 'aborted');
  assert.deepEqual(f.loop.snapshotFileState().allowedReadFiles, []); assert.equal(run.events.some(event => event.type === 'steer_applied'), false);
});

test('abort during durable append preserves the record but prevents a new model call or tool permission', async () => {
  const f = fixture(), controller = new AbortController(), durable: CanonicalMessage[] = [], applied: string[] = [];
  const run = await collect(f.loop.run({ sessionId: 's', turnId: 't', messages: [], abortSignal: controller.signal,
    drainSteerMessages: drainOnce(steer(async () => true)), onSteerApplied: id => { applied.push(id); },
    onDurableMessage: async msg => { durable.push(msg); await Promise.resolve(); controller.abort('team_stopped'); },
  }));
  assert.equal(durable.includes(message), true); assert.equal(f.requests.length, 0); assert.equal(run.result.result.type, 'aborted');
  assert.deepEqual(applied, []); assert.deepEqual(f.loop.snapshotFileState().allowedReadFiles, []);
});

test('turn budget leaves accepted Team delivery unapplied for the host without extending Leader lifetime', async () => {
  const f = fixture(), transcript = new InMemoryTranscriptWriter(), delivery = new TeamMessageDelivery(), controller = new AbortController();
  const session = new AgentSession({ sessionId: 's', uuid: () => 't', turnRunner: new TurnRunner(f.loop, transcript, undefined, undefined, undefined, { cwd: '/workspace', transcriptPath: '', collectFileArtifacts: false }) });
  let receipt: Promise<boolean> | undefined; const events: AgentEvent[] = [];
  for await (const event of session.submit({ type: 'text', text: 'start' }, { maxTurns: 1 })) {
    events.push(event); delivery.observe('s', event);
    if (event.type === 'model_request_started') {
      receipt = delivery.deliver({ sessionKey: 's', turnId: 't', itemId: 'event-1', message, signal: controller.signal, isCurrent: async () => true, wasApplied: async () => false,
        enqueue: beforeApply => session.steer({ turnId: 't', ...steer(beforeApply) }), cancel: () => { session.cancelSteer({ turnId: 't', itemId: 'event-1' }); },
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  assert.ok(receipt); assert.equal(await receipt, false); assert.equal(f.requests.length, 1);
  assert.ok(events.some(event => event.type === 'steer_unapplied' && event.itemId === 'event-1'));
  assert.ok(!transcript.entries.some(entry => entry.type === 'durable_message' && entry.message.metadata?.queueItemId === 'event-1'));
});

test('a message received during a tool batch waits for paired tool results before the next LLM request', async () => {
  let queued: AgentSteerMessage[] = [], appliedDuringTool = false;
  const f = fixture({
    async *respond(_request, index) {
      if (index === 1) {
        yield { type: 'tool_call_start', id: 'call-1', name: 'controlled_tool' };
        yield { type: 'tool_call_end', toolCall: { id: 'call-1', name: 'controlled_tool', input: {} } };
      } else { yield { type: 'message_start', role: 'assistant' }; yield { type: 'text_delta', text: 'done' }; yield { type: 'message_end', finishReason: 'stop' }; }
    },
    async onTools() { queued = [steer(async () => true)]; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(appliedDuringTool, false); },
  });
  const run = await collect(f.loop.run({ sessionId: 's', turnId: 't', messages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }],
    drainSteerMessages: () => { const result = queued; queued = []; return result; },
    onSteerApplied: () => { appliedDuringTool = true; },
  }));
  assert.equal(f.requests.length, 2);
  const second = f.requests[1]!.messages;
  const call = second.findIndex(msg => msg.content.some(block => block.type === 'tool_call' && block.id === 'call-1'));
  const result = second.findIndex(msg => msg.content.some(block => block.type === 'tool_result' && block.toolCallId === 'call-1'));
  const notice = second.findIndex(msg => msg.metadata?.queueItemId === 'event-1');
  assert.ok(call >= 0 && result > call && notice > result);
  const toolEvent = run.events.findIndex(event => event.type === 'tool_result');
  const appliedEvent = run.events.findIndex(event => event.type === 'steer_applied');
  assert.ok(toolEvent >= 0 && appliedEvent > toolEvent);
});
