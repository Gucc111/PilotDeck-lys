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

test('participant history sorts injected batches by timeline instead of arrival order', () => {
  const block = (id: string, order: number, text: string) => ({
    type: 'text' as const,
    text,
    blockId: id,
    timeline: { version: 1 as const, turnId: 'turn', id, order, revision: 1 },
  });
  const entries: AgentTranscriptEntry[] = [
    { type: 'accepted_input', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 1, transcriptOrder: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }] },
    { type: 'assistant_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 2, transcriptOrder: 2, message: { role: 'assistant', content: [block('old', 0, 'old output')] } },
    { type: 'durable_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 3, transcriptOrder: 3, message: { role: 'user', content: [block('marker-1', 1, 'batch one')] } },
    { type: 'assistant_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 4, transcriptOrder: 4, message: { role: 'assistant', content: [block('new-1', 2, 'new output one')] } },
    { type: 'durable_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 5, transcriptOrder: 5, message: { role: 'user', content: [block('marker-2', 3, 'batch two')] } },
    { type: 'assistant_message', sessionId: 'internal', turnId: 'turn', createdAt: stamp, sequence: 6, transcriptOrder: 6, message: { role: 'assistant', content: [block('new-2', 4, 'new output two')] } },
  ];
  const shuffled = [...entries].reverse();
  const projected = projectParticipantTranscript(shuffled);
  assert.deepEqual(projected.map(message => (message.content as any)?.[0]?.text), ['start', 'old output', 'batch one', 'new output one', 'batch two', 'new output two']);
});

test('participant stream snapshot orders out-of-order live events and ignores stale revisions', () => {
  const stream = new TeamParticipantStream(() => new Date(stamp));
  const later = { type: 'model_event' as const, sessionId: 'internal', turnId: 'turn', blockId: 'later', timeline: { version: 1 as const, turnId: 'turn', id: 'later', order: 2, revision: 2, offset: 0 }, event: { type: 'text_delta' as const, text: 'later' } };
  const earlier = { type: 'model_event' as const, sessionId: 'internal', turnId: 'turn', blockId: 'earlier', timeline: { version: 1 as const, turnId: 'turn', id: 'earlier', order: 1, revision: 1, offset: 0 }, event: { type: 'text_delta' as const, text: 'earlier' } };
  stream.observe(later);
  stream.observe(earlier);
  stream.observe({ ...later, timeline: { ...later.timeline, revision: 1 }, event: { type: 'text_delta', text: 'stale' } });
  assert.deepEqual(stream.snapshot().map(message => (message.content as any)?.[0]?.text), ['earlier', 'later']);
  assert.equal((stream.snapshot()[1]?.content as any)?.[0]?.text, 'later');
});
