import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamParticipantStream, projectParticipantTranscript } from '../../src/team/participantStream.js';
import type { AgentEvent } from '../../src/agent/protocol/events.js';
import type { AgentTranscriptEntry } from '../../src/session/transcript/TranscriptEntry.js';

const stamp = '2026-10-28T00:00:00.000Z';
const position = { version: 1 as const, turnId: 'turn', id: 'block', order: 0, revision: 1, offset: 0 };
const delta = (text: string, offset: number): AgentEvent => ({ type: 'model_event', sessionId: 'internal', turnId: 'turn', blockId: 'block', timeline: { ...position, offset }, event: { type: 'text_delta', text } });

test('member live blocks reconcile by stable identity with persisted content without duplicated text', () => {
  const stream = new TeamParticipantStream(() => new Date(stamp));
  assert.equal(stream.observe(delta('Hello', 0))[0]?.isStreaming, true);
  stream.observe(delta(' world', 5));
  // A repeated offset must replace the corresponding bytes, not append twice.
  stream.observe(delta(' world', 5));
  assert.equal((stream.snapshot()[0]?.content as any)[0].text, 'Hello world');
  const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hello world!', blockId: 'block', timeline: position }] };
  const completed = stream.observe({ type: 'assistant_message', sessionId: 'internal', turnId: 'turn', message });
  assert.equal(completed[0]?.isStreaming, false);
  const persisted = projectParticipantTranscript([{ type: 'assistant_message', sessionId: 'internal', turnId: 'turn', message, createdAt: stamp, sequence: 1, entryId: 'disk-id' }]);
  assert.equal(persisted[0]?.id, completed[0]?.id);
  assert.deepEqual(persisted[0]?.content, completed[0]?.content);
  assert.equal(stream.snapshot().length, 1);
  assert.ok(!JSON.stringify(stream.snapshot()).includes('internal'));
});

test('private transcript preserves inputs, tool identity, results and status with no generated session paths', () => {
  const entries: AgentTranscriptEntry[] = [
    { type: 'accepted_input', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'do work' }] }] },
    { type: 'assistant_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 2, message: { role: 'assistant', content: [{ type: 'tool_call', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }] } },
    { type: 'tool_result_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 3, message: { role: 'user', content: [{ type: 'tool_result', toolCallId: 'tool-1', content: [{ type: 'text', text: 'read result' }] }] } },
    { type: 'agent_status_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 4, event: 'stopped', kind: 'status', text: 'Stopped' },
  ];
  const persisted = projectParticipantTranscript(entries);
  const stream = new TeamParticipantStream(() => new Date(stamp));
  const inputs = stream.observe({ type: 'input_accepted', sessionId: 'internal', turnId: 'turn', messages: [{ role: 'user', content: [{ type: 'text', text: 'do work' }] }] });
  const calls = stream.observe({ type: 'tool_calls_detected', sessionId: 'internal', turnId: 'turn', calls: [{ id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }] });
  assert.equal(inputs[0]?.id, persisted[0]?.id);
  assert.equal(calls[0]?.id, persisted[1]?.id);
  assert.equal(persisted[2]?.id, 'turn:result:tool-1');
  assert.equal(persisted[3]?.text, 'Stopped');
  assert.ok(!JSON.stringify(persisted).includes('internal'));
});

test('internal input is visible only after actual dispatch and keeps its injection metadata', () => {
  const stream = new TeamParticipantStream(() => new Date(stamp));
  const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Leader: keep the old API' }], metadata: { purpose: 'team_runtime' } };
  assert.deepEqual(stream.observe({ type: 'input_accepted', sessionId: 'internal', turnId: 'turn', messages: [message] }), []);
  const consumed = { ...message, metadata: { ...message.metadata, teamConsumed: true, teamInjectionMode: 'during' as const, teamEventIds: ['message-1'], teamRequestId: 'request-1' } };
  const live = stream.observe({ type: 'steer_applied', sessionId: 'internal', turnId: 'turn', itemId: 'batch-1', message: consumed });
  const history = projectParticipantTranscript([{ type: 'durable_message', sessionId: 'internal', turnId: 'turn', message: consumed, createdAt: stamp, sequence: 1, entryId: 'durable' }]);
  assert.equal(live[0]?.metadata?.teamConsumed, true);
  assert.equal(live[0]?.id, history[0]?.id);
  assert.deepEqual(live[0]?.metadata, history[0]?.metadata);
});
