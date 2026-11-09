import type { AgentEvent } from '../agent/protocol/events.js';
import type { CanonicalMessage } from '../model/protocol/canonical.js';
import type { AgentTranscriptEntry } from '../session/transcript/TranscriptEntry.js';
import type { TeamParticipantMessage } from './runtimeTypes.js';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Shared ordering for persisted and live Teammate projections.
 * Physical transcript order is the fallback for legacy rows; protocol timeline
 * order wins inside a turn when it is available.
 */
export function compareParticipantMessages(left: TeamParticipantMessage, right: TeamParticipantMessage): number {
  const leftTurn = left.timeline?.turnId ?? left.turnId ?? '';
  const rightTurn = right.timeline?.turnId ?? right.turnId ?? '';
  if (finite(left.turnOrder) && finite(right.turnOrder) && left.turnOrder !== right.turnOrder) {
    return left.turnOrder - right.turnOrder;
  }
  if (leftTurn && leftTurn === rightTurn) {
    const leftTimeline = left.timeline;
    const rightTimeline = right.timeline;
    if (leftTimeline && rightTimeline && leftTimeline.order !== rightTimeline.order) {
      return leftTimeline.order - rightTimeline.order;
    }
    if (!leftTimeline && rightTimeline && left.role === 'user') return -1;
    if (leftTimeline && !rightTimeline && right.role === 'user') return 1;
  }
  if (finite(left.transcriptOrder) && finite(right.transcriptOrder) && left.transcriptOrder !== right.transcriptOrder) {
    return left.transcriptOrder - right.transcriptOrder;
  }
  if (finite(left.sequence) && finite(right.sequence) && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  const leftTime = Date.parse(String(left.createdAt ?? left.timestamp ?? ''));
  const rightTime = Date.parse(String(right.createdAt ?? right.timestamp ?? ''));
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  // Legacy participant rows can have no coordinates. Keep their stable input
  // order instead of sorting by arbitrary ids.
  return 0;
}

function mergeParticipantMessage(target: Map<string, TeamParticipantMessage>, message: TeamParticipantMessage): void {
  const previous = target.get(message.id);
  if (previous) {
    const previousRevision = previous.timeline?.revision;
    const nextRevision = message.timeline?.revision;
    if (finite(previousRevision) && finite(nextRevision) && previousRevision > nextRevision) return;
    if (previous.isStreaming && !message.isStreaming) {
      target.set(message.id, message);
      return;
    }
  }
  target.set(message.id, message);
}


/** Stable block identities are shared by the live view and the durable transcript. */
export function projectParticipantMessage(message: CanonicalMessage, turnId: string, fallback: string, createdAt: string, position: { sequence?: number; transcriptOrder?: number; turnOrder?: number; timeline?: import('../model/protocol/timeline.js').TimelinePosition } = {}): TeamParticipantMessage[] {
  if (message.metadata?.purpose === 'team_runtime_wakeup' || (message.metadata?.purpose === 'team_runtime' && !message.metadata.teamConsumed)) return [];
  return message.content.map((block, index) => {
    const identity = block.timeline?.id
      ?? ((block.type === 'text' || block.type === 'thinking') ? block.blockId : undefined)
      ?? (block.type === 'tool_call' ? `tool:${block.id}` : undefined)
      ?? ((block.type === 'tool_result' || block.type === 'tool_result_reference') ? `result:${block.toolCallId}` : undefined)
      ?? `${message.metadata?.teamRequestId ?? message.metadata?.queueItemId ?? fallback}:${index}`;
    return { id: `${turnId}:${identity}`, turnId, role: message.role, content: [structuredClone(block)], createdAt, isStreaming: false, metadata: message.metadata ? structuredClone(message.metadata) : undefined, sequence: position.sequence, transcriptOrder: position.transcriptOrder, turnOrder: position.turnOrder, timeline: block.timeline ?? position.timeline };
  });
}

export function projectParticipantTranscript(entries: AgentTranscriptEntry[]): TeamParticipantMessage[] {
  const messages = new Map<string, TeamParticipantMessage>();
  const turnOrders = new Map<string, number>();
  for (const entry of entries) if (entry.type === 'accepted_input') turnOrders.set(entry.turnId, entry.transcriptOrder ?? entry.sequence);
  const position = (entry: AgentTranscriptEntry) => ({ sequence: entry.sequence, transcriptOrder: entry.transcriptOrder, turnOrder: turnOrders.get(entry.turnId) ?? entry.transcriptOrder ?? entry.sequence });
  for (const entry of entries) {
    let projected: TeamParticipantMessage[] = [];
    if (entry.type === 'accepted_input') {
      if (entry.metadata?.purpose === 'team_runtime_wakeup') continue;
      projected = entry.messages.flatMap((message, index) => projectParticipantMessage(message, entry.turnId, `input:${index}`, entry.createdAt, position(entry)));
    } else if (entry.type === 'assistant_message' || entry.type === 'tool_result_message' || entry.type === 'durable_message') {
      projected = projectParticipantMessage(entry.message, entry.turnId, entry.entryId ?? String(entry.sequence), entry.createdAt, position(entry));
    } else if (entry.type === 'agent_status_message') {
      projected = [{ id: entry.entryId ?? `${entry.turnId}:status:${entry.sequence}`, turnId: entry.turnId, role: 'system', text: entry.text, createdAt: entry.createdAt, sequence: entry.sequence, transcriptOrder: entry.transcriptOrder, turnOrder: turnOrders.get(entry.turnId) ?? entry.transcriptOrder ?? entry.sequence }];
    }
    for (const message of projected) mergeParticipantMessage(messages, message);
  }
  return [...messages.values()].sort(compareParticipantMessages);
}

/** Only the currently executing member turn is retained in memory. Reconnect
 * reads this projection together with disk, without replaying any model turn. */
export class TeamParticipantStream {
  private readonly messages = new Map<string, TeamParticipantMessage>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  snapshot(): TeamParticipantMessage[] { return structuredClone([...this.messages.values()].sort(compareParticipantMessages)); }

  observe(event: AgentEvent): TeamParticipantMessage[] {
    let updates: TeamParticipantMessage[] = [];
    const createdAt = this.now().toISOString();
    if (event.type === 'input_accepted') {
      updates = event.messages.flatMap((message, index) => projectParticipantMessage(message, event.turnId, `input:${index}`, createdAt, { timeline: event.timeline }));
    } else if (event.type === 'assistant_message' || event.type === 'tool_results_projected' || event.type === 'steer_applied') {
      updates = projectParticipantMessage(event.message, event.turnId, event.type === 'steer_applied' ? event.itemId : event.type, createdAt, { timeline: event.timeline });
    } else if (event.type === 'model_event' && event.blockId && (event.event.type === 'text_delta' || event.event.type === 'thinking_delta')) {
      const id = `${event.turnId}:${event.blockId}`;
      const old = this.messages.get(id);
      const oldBlock = (old?.content as Array<{ text?: string }> | undefined)?.[0];
      const previous = oldBlock?.text ?? '';
      const offset = event.timeline?.offset ?? previous.length;
      const text = previous.slice(0, offset) + event.event.text;
      updates = [{ id, turnId: event.turnId, role: 'assistant', createdAt: old?.createdAt ?? createdAt, isStreaming: true,
        content: [{ type: event.event.type === 'text_delta' ? 'text' : 'thinking', text, blockId: event.blockId, timeline: event.timeline }], timeline: event.timeline }];
    } else if (event.type === 'tool_calls_detected') {
      updates = projectParticipantMessage({ role: 'assistant', content: event.calls.map(call => ({ ...call, type: 'tool_call' })) }, event.turnId, 'tools', createdAt, { timeline: event.timeline });
    }
    for (const message of updates) {
      const previous = this.messages.get(message.id);
      if (previous) message.createdAt = previous.createdAt;
      mergeParticipantMessage(this.messages, message);
    }
    return structuredClone(updates.sort(compareParticipantMessages));
  }
}
