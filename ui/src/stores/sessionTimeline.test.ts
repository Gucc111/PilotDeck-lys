import { describe, expect, it } from 'vitest';
import { SessionTimeline, mergeTimeline } from './sessionTimeline';
import { computeMerged, type NormalizedMessage } from './useSessionStore';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';

const frame = (id: string, order: number, revision: number, content: string, offset?: number,
  overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `wire-${revision}`, sessionId: 's', runId: 'turn', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
  kind: 'stream_delta', role: 'assistant', content,
  timeline: { version: 1, turnId: 'turn', id, order, revision, ...(offset !== undefined ? { offset } : {}) },
  ...overrides,
});
const read = (state: SessionTimeline) => state.values().sort((a, b) => a.timeline!.order - b.timeline!.order)
  .map(m => [m.timeline!.id, m.content, m.streamState]);

describe('versioned session timeline', () => {
  it('keeps alternating thought/text/thought in place and only the tail active', () => {
    const state = new SessionTimeline();
    state.apply(frame('thought-0', 0, 1, 'think', 0, { kind: 'thinking' }));
    state.apply(frame('text-0', 1, 2, 'say', 0));
    state.apply(frame('thought-1', 2, 3, 'again', 0, { kind: 'thinking' }));
    expect(read(state)).toEqual([['thought-0', 'think', 'closed'], ['text-0', 'say', 'closed'], ['thought-1', 'again', 'open']]);
    const rows = normalizedToChatMessages(state.values());
    expect(rows.filter(m => m.isStreaming).map(m => m.content)).toEqual(['again']);
  });

  it('uses offsets for duplicates/gaps, including a missing first packet', () => {
    const state = new SessionTimeline();
    expect(state.apply(frame('a', 0, 2, ' world', 5))).toBe(true);
    expect(state.values()).toEqual([]);
    expect(state.apply(frame('a', 0, 1, 'hello', 0))).toBe(false);
    state.apply(frame('a', 0, 1, 'hello', 0));
    expect(read(state)).toEqual([['a', 'hello world', 'open']]);
  });

  it('detects an entirely missing predecessor and recovers from the absolute baseline', () => {
    const state = new SessionTimeline();
    const next = frame('b', 1, 3, 'second', 0);
    next.timeline!.previousId = 'a';
    expect(state.apply(next)).toBe(true);
    expect(state.apply(frame('a', 0, 2, 'first', undefined, { isFinal: true }))).toBe(false);
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['b', 'second', 'open']]);
  });

  it('an old baseline neither rewinds text nor reopens a settled block', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'hello', 0));
    const id = state.values()[0].id;
    state.apply(frame('a', 0, 2, ' world', 5));
    state.apply(frame('a', 0, 1, 'hello'));
    state.apply(frame('a', 0, 3, 'hello world', undefined, { kind: 'text', isFinal: true }));
    state.apply(frame('a', 0, 2, ' world', 5));
    expect(state.values()[0].id).toBe(id);
    expect(read(state)).toEqual([['a', 'hello world', 'closed']]);
  });

  it('late model-end boundaries cannot close a later attempt', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'first', 0));
    state.apply(frame('retry', 1, 3, 'retry', 0));
    state.close('turn', false, undefined, { turnId: 'turn', through: 0 });
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['retry', 'retry', 'open']]);
    state.close('turn', true);
    state.apply(frame('retry', 1, 4, ' stale', 5));
    expect(read(state)).toEqual([['a', 'first', 'closed'], ['retry', 'retry', 'closed']]);
  });

  it('inserting snapshots/duplicates at every reconnect point has the same final result', () => {
    const deltas = [frame('a', 0, 1, 'abc', 0), frame('a', 0, 2, 'def', 3),
      frame('b', 1, 4, 'ghi', 0, { kind: 'thinking' }), frame('b', 1, 5, 'jkl', 3, { kind: 'thinking' })];
    const snapshots = [frame('a', 0, 3, 'abcdef', undefined, { kind: 'text', isFinal: true }),
      frame('b', 1, 6, 'ghijkl', undefined, { kind: 'thinking', isFinal: true })];
    const expected = [['a', 'abcdef', 'closed'], ['b', 'ghijkl', 'closed']];
    for (let reconnect = 0; reconnect <= deltas.length; reconnect++) {
      for (let seed = 1; seed <= 30; seed++) {
        const state = new SessionTimeline();
        let random = seed;
        const shuffle = (items: NormalizedMessage[]) => items.map(m => ({ m, n: (random = (random * 16807) % 2147483647) }))
          .sort((a, b) => a.n - b.n).map(x => x.m);
        const prefix = deltas.slice(0, reconnect);
        for (const m of prefix) state.apply(m);
        for (const m of shuffle([...deltas, ...deltas, ...snapshots, ...snapshots])) state.apply(m);
        expect(state.hasGap).toBe(false);
        expect(read(state)).toEqual(expected);
      }
    }
  });

  it('does not use status rows as anchors or compare repeated text', () => {
    const user: NormalizedMessage = { ...frame('u', 0, 0, 'question'), timeline: undefined, role: 'user', kind: 'text' };
    const status = { ...user, id: 'status', kind: 'status' as const, role: undefined };
    const a = frame('a', 0, 1, 'same', undefined, { isFinal: true, kind: 'text' });
    const b = frame('b', 1, 2, 'same', undefined, { isFinal: true, kind: 'text' });
    const merged = computeMerged([user, a], [status, b]);
    expect(merged.filter(m => m.kind === 'text').map(m => m.content)).toEqual(['question', 'same', 'same']);
    expect(new Set(merged.filter(m => m.timeline).map(m => m.renderKey)).size).toBe(2);
    expect(mergeTimeline([status, user], [b, a]).filter(m => m.kind === 'text').map(m => m.content))
      .toEqual(['question', 'same', 'same']);
  });

  it('keeps child and parent identities and lifecycle separate', () => {
    const state = new SessionTimeline();
    state.apply(frame('a', 0, 1, 'parent', 0));
    const child = frame('a', 0, 1, 'child', 0, { subagentId: 'child', isSubagentDetail: true });
    child.timeline!.turnId = 'child-turn';
    state.apply(child);
    state.close('turn', false, 'child', { turnId: 'child-turn', through: 0 });
    expect(state.values()[0].streamState).toBe('open');
    expect(state.values('child')[0].streamState).toBe('closed');
    const persisted = { ...child, sessionId: 's::sub::child', subagentId: undefined, runId: 'child-turn',
      timeline: { ...child.timeline!, revision: 2, offset: undefined }, isFinal: true };
    expect(computeMerged([persisted], [state.values('child')[0]])).toHaveLength(1);
  });

  it('orders two consumed Team batches by durable positions when history and realtime arrive interleaved', () => {
    const makeText = (id: string, turnId: string, order: number, transcriptOrder: number, content: string, turnOrder = 10): NormalizedMessage => ({
      ...frame(id, order, order + 1, content, undefined, {
        id,
        turnId,
        runId: turnId,
        timeline: { version: 1, turnId, id, order, revision: order + 1 },
        transcriptOrder,
        turnOrder,
        kind: 'text',
        isFinal: true,
      }),
    });
    const marker = (id: string, batchId: string, transcriptOrder: number): NormalizedMessage => ({
      id,
      sessionId: 's', runId: 'turn-a', turnId: 'turn-a', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'assistant', kind: 'team_message', content: 'same visible marker',
      teamBatchId: batchId, teamInjectionMode: 'during', transcriptOrder, turnOrder: 10,
    });
    const user: NormalizedMessage = {
      id: 'user-a', sessionId: 's', runId: 'turn-a', turnId: 'turn-a', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'user', kind: 'text', content: 'start', transcriptOrder: 1, turnOrder: 10,
    };
    const output1 = makeText('output-1', 'turn-a', 0, 4, 'first response');
    const output2 = makeText('output-2', 'turn-a', 1, 6, 'second response');
    const batch1 = marker('batch-1', 'team:batch:1', 3);
    const batch2 = marker('batch-2', 'team:batch:2', 5);

    const ids = (messages: NormalizedMessage[]) => messages.map(message => message.timeline?.id ?? message.id);
    // The persisted snapshot arrives in reverse order while the live frames
    // arrive in a different interleaving. Stable transcript positions must win.
    const merged = computeMerged(
      [batch2, output2, user, output1, batch1],
      [batch1, output1, batch2, output2],
    );
    expect(ids(merged)).toEqual(['user-a', 'batch-1', 'output-1', 'batch-2', 'output-2']);
    expect(merged.filter(message => message.kind === 'team_message').map(message => message.teamBatchId))
      .toEqual(['team:batch:1', 'team:batch:2']);
  });

  it('keeps repeated marker text distinct and deduplicates duplicate live events', () => {
    const user: NormalizedMessage = {
      id: 'user', sessionId: 's', runId: 'turn', turnId: 'turn', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'user', kind: 'text', content: 'begin', transcriptOrder: 1, turnOrder: 1,
    };
    const output = (id: string, order: number, transcriptOrder: number, text: string): NormalizedMessage => ({
      ...frame(id, order, order + 1, text, undefined, {
        id, turnId: 'turn', runId: 'turn', kind: 'text', isFinal: true,
        timeline: { version: 1, turnId: 'turn', id, order, revision: order + 1 }, transcriptOrder, turnOrder: 1,
      }),
    });
    const marker = (id: string, batchId: string, transcriptOrder: number): NormalizedMessage => ({
      id, sessionId: 's', runId: 'turn', turnId: 'turn', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'assistant', kind: 'team_message', content: 'same text', teamBatchId: batchId,
      teamInjectionMode: 'during', transcriptOrder, turnOrder: 1,
    });
    const first = marker('marker-1', 'batch-1', 2);
    const second = marker('marker-2', 'batch-2', 4);
    const merged = computeMerged(
      [user, first, output('out-1', 0, 3, 'one'), second, output('out-2', 1, 5, 'two')],
      [first, second, output('out-2', 1, 5, 'two')],
    );
    expect(merged.map(message => message.timeline?.id ?? message.id)).toEqual(['user', 'marker-1', 'out-1', 'marker-2', 'out-2']);
    expect(merged.filter(message => message.kind === 'team_message')).toHaveLength(2);
  });

  it('keeps automatic and later human turns in transcript order', () => {
    const user = (id: string, turnId: string, text: string, transcriptOrder: number, turnOrder: number): NormalizedMessage => ({
      id, sessionId: 's', runId: turnId, turnId, timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'user', kind: 'text', content: text, transcriptOrder, turnOrder,
    });
    const answer = (id: string, turnId: string, text: string, order: number, transcriptOrder: number, turnOrder: number): NormalizedMessage => ({
      ...frame(id, order, order + 1, text, undefined, {
        id, turnId, runId: turnId, kind: 'text', isFinal: true,
        timeline: { version: 1, turnId, id, order, revision: order + 1 }, transcriptOrder, turnOrder,
      }),
    });
    const autoMarker: NormalizedMessage = {
      id: 'auto-batch', sessionId: 's', runId: 'auto', turnId: 'auto', timestamp: '2026-09-16T00:00:00Z', provider: 'pilotdeck',
      role: 'assistant', kind: 'team_message', content: 'automatic batch', teamBatchId: 'auto-batch', teamInjectionMode: 'start',
      transcriptOrder: 3, turnOrder: 3,
    };
    const messages = computeMerged(
      [
        user('human-1', 'human-1', 'first question', 1, 1),
        answer('human-1-answer', 'human-1', 'first answer', 0, 2, 1),
        autoMarker,
        answer('auto-answer', 'auto', 'automatic answer', 0, 4, 3),
        user('human-2', 'human-2', 'follow up', 5, 5),
        answer('human-2-answer', 'human-2', 'follow up answer', 0, 6, 5),
      ],
      [],
    );
    expect(messages.map(message => message.timeline?.id ?? message.id)).toEqual([
      'human-1', 'human-1-answer', 'auto-batch', 'auto-answer', 'human-2', 'human-2-answer',
    ]);
  });

  it('keeps automatic Team turn output below its start and busy dispatch markers after history or reconnect', () => {
    const user: NormalizedMessage = { ...frame('human', 0, 0, 'Fix login'), timeline: undefined, role: 'user', kind: 'text', turnId: 'human', runId: 'human', sequence: 1 };
    const oldFinal = { ...frame('old-final', 0, 1, 'Earlier final', undefined, { kind: 'text', isFinal: true }), turnId: 'human', runId: 'human', timeline: { version: 1 as const, turnId: 'human', id: 'old-final', order: 0, revision: 1 }, sequence: 2 };
    const start: NormalizedMessage = { ...user, id: 'start', role: 'assistant', kind: 'team_message', turnId: 'auto', runId: 'auto', sequence: 3, teamInjectionMode: 'start', timestamp: '2026-09-16T00:00:02Z' };
    const busy: NormalizedMessage = { ...start, id: 'busy', sequence: 5, teamInjectionMode: 'during', timestamp: '2026-09-16T00:00:04Z' };
    const first = frame('auto-tool', 0, 1, 'Inspect result', undefined, { kind: 'tool_use', turnId: 'auto', runId: 'auto', timeline: { version: 1, turnId: 'auto', id: 'auto-tool', order: 0, revision: 1 }, sequence: 4, timestamp: '2026-09-16T00:00:03Z' });
    const final = frame('auto-final', 1, 2, 'Updated login', undefined, { kind: 'text', isFinal: true, turnId: 'auto', runId: 'auto', timeline: { version: 1, turnId: 'auto', id: 'auto-final', order: 1, revision: 2 }, sequence: 6, timestamp: '2026-09-16T00:00:05Z' });
    const ids = (messages: NormalizedMessage[]) => messages.map(message => message.kind === 'team_message' ? message.id : message.content);
    const oldBusy: NormalizedMessage = { ...user, id: 'old-busy', role: 'assistant', kind: 'team_message', sequence: 2.5, teamInjectionMode: 'during' };
    const oldError: NormalizedMessage = { ...user, id: 'old-error', role: undefined, kind: 'error', content: 'Previous turn reached its limit', sequence: 2.75 };
    const expected = ['Fix login', 'Earlier final', 'old-busy', 'Previous turn reached its limit', 'start', 'Inspect result', 'busy', 'Updated login'];
    expect(ids(computeMerged([user, oldFinal, oldBusy, oldError, start, first, busy, final], []))).toEqual(expected);
    // Live frames have no transcript sequence. Their actual dispatch time
    // still places a busy injection between the surrounding model blocks.
    const live = [start, first, busy, final].map(message => ({ ...message, sequence: undefined }));
    expect(ids(computeMerged([user, oldFinal, oldBusy, oldError], live))).toEqual(expected);
    expect(ids(computeMerged([user, oldFinal, oldBusy, oldError, start, first, busy, final], live))).toEqual(expected);
  });
});

it('restores a terminated child snapshot without reopening it or blocking the parent', () => {
  const state = new SessionTimeline();
  state.close('turn', true, 'child');
  const child = frame('thought', 0, 1, 'Restored thought', undefined, {
    kind: 'thinking', isSubagentDetail: true, subagentId: 'child', streamState: 'open',
  });
  child.timeline!.turnId = 'child-t0';
  state.apply(child);
  expect(state.values('child')[0]).toMatchObject({ content: 'Restored thought', streamState: 'closed' });
  expect(state.apply({ ...child, content: ' late', timeline: { ...child.timeline!, offset: 16, revision: 2 } })).toBe(false);
  expect(state.values('child')[0].content).toBe('Restored thought');
  state.apply(frame('parent', 0, 1, 'Parent continues', 0));
  expect(state.values()[0].streamState).toBe('open');
});

it('terminal recovery clears orphaned predecessors, pending deltas and conflicts only for that turn', () => {
  const state = new SessionTimeline();
  const retry = frame('retry', 2, 3, 'Recovered', 0);
  retry.timeline!.previousId = 'tool:discarded';
  expect(state.apply(retry)).toBe(true);
  state.apply(frame('pending', 3, 4, 'tail', 10));
  state.apply(frame('retry', 2, 3, 'conflict', 0));
  state.apply(frame('retry', 2, 5, 'Recovered', undefined, { isFinal: true }));
  const other = frame('other', 0, 1, 'tail', 4, { runId: 'other-run' });
  other.timeline!.turnId = 'other-run';
  state.apply(other);
  state.close('turn', true);
  expect(state.hasGap).toBe(true); // The other active turn still needs recovery.
  expect(state.apply({ ...other, content: 'head', timeline: { ...other.timeline!, offset: 0 } })).toBe(false);
  expect(state.apply(retry)).toBe(false); // Late packets cannot recreate the discarded dependency.
  const next = frame('next', 0, 1, 'New turn', 0, { runId: 'next-run' });
  next.timeline!.turnId = 'next-run';
  expect(state.apply(next)).toBe(false);
});
