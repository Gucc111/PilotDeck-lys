import type { AgentEvent } from '../agent/protocol/events.js';
import type { CanonicalMessage } from '../model/protocol/canonical.js';
import type { AgentTranscriptEntry } from '../session/transcript/TranscriptEntry.js';
import type { TeamParticipantMessage } from './runtimeTypes.js';

/** Stable block identities are shared by the live view and the durable transcript. */
export function projectParticipantMessage(message: CanonicalMessage, turnId: string, fallback: string, createdAt: string): TeamParticipantMessage[] {
  return message.content.map((block, index) => {
    const identity = block.timeline?.id
      ?? ((block.type === 'text' || block.type === 'thinking') ? block.blockId : undefined)
      ?? (block.type === 'tool_call' ? `tool:${block.id}` : undefined)
      ?? ((block.type === 'tool_result' || block.type === 'tool_result_reference') ? `result:${block.toolCallId}` : undefined)
      ?? `${message.metadata?.queueItemId ?? fallback}:${index}`;
    return { id: `${turnId}:${identity}`, turnId, role: message.role, content: [structuredClone(block)], createdAt, isStreaming: false };
  });
}

export function projectParticipantTranscript(entries: AgentTranscriptEntry[]): TeamParticipantMessage[] {
  const messages = new Map<string, TeamParticipantMessage>();
  for (const entry of entries) {
    let projected: TeamParticipantMessage[] = [];
    if (entry.type === 'accepted_input') {
      projected = entry.messages.flatMap((message, index) => projectParticipantMessage(message, entry.turnId, `input:${index}`, entry.createdAt));
    } else if (entry.type === 'assistant_message' || entry.type === 'tool_result_message' || entry.type === 'durable_message') {
      projected = projectParticipantMessage(entry.message, entry.turnId, entry.entryId ?? String(entry.sequence), entry.createdAt);
    } else if (entry.type === 'agent_status_message') {
      projected = [{ id: entry.entryId ?? `${entry.turnId}:status:${entry.sequence}`, turnId: entry.turnId, role: 'system', text: entry.text, createdAt: entry.createdAt }];
    }
    for (const message of projected) messages.set(message.id, message);
  }
  return [...messages.values()];
}

/** Only the currently executing member turn is retained in memory. Reconnect
 * reads this projection together with disk, without replaying any model turn. */
export class TeamParticipantStream {
  private readonly messages = new Map<string, TeamParticipantMessage>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  snapshot(): TeamParticipantMessage[] { return structuredClone([...this.messages.values()]); }

  observe(event: AgentEvent): TeamParticipantMessage[] {
    let updates: TeamParticipantMessage[] = [];
    const createdAt = this.now().toISOString();
    if (event.type === 'input_accepted') {
      updates = event.messages.flatMap((message, index) => projectParticipantMessage(message, event.turnId, `input:${index}`, createdAt));
    } else if (event.type === 'assistant_message' || event.type === 'tool_results_projected' || event.type === 'steer_applied') {
      updates = projectParticipantMessage(event.message, event.turnId, event.type === 'steer_applied' ? event.itemId : event.type, createdAt);
    } else if (event.type === 'model_event' && event.blockId && (event.event.type === 'text_delta' || event.event.type === 'thinking_delta')) {
      const id = `${event.turnId}:${event.blockId}`;
      const old = this.messages.get(id);
      const oldBlock = (old?.content as Array<{ text?: string }> | undefined)?.[0];
      const previous = oldBlock?.text ?? '';
      const offset = event.timeline?.offset ?? previous.length;
      const text = previous.slice(0, offset) + event.event.text;
      updates = [{ id, turnId: event.turnId, role: 'assistant', createdAt: old?.createdAt ?? createdAt, isStreaming: true,
        content: [{ type: event.event.type === 'text_delta' ? 'text' : 'thinking', text, blockId: event.blockId, timeline: event.timeline }] }];
    } else if (event.type === 'tool_calls_detected') {
      updates = projectParticipantMessage({ role: 'assistant', content: event.calls.map(call => ({ ...call, type: 'tool_call' })) }, event.turnId, 'tools', createdAt);
    }
    for (const message of updates) {
      const previous = this.messages.get(message.id);
      if (previous) message.createdAt = previous.createdAt;
      this.messages.set(message.id, message);
    }
    return structuredClone(updates);
  }
}
