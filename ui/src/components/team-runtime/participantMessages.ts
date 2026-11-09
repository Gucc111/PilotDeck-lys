import type { CanonicalContentBlock } from '../../../../src/model/protocol/canonical';
import type { TeamParticipantMessage } from '../../../../src/team/runtimeTypes';
import { compareParticipantMessages } from '../../../../src/team/participantStream';
import type { ChatMessage, ToolResult } from '../chat/types/types';

function teamDisplayText(message: TeamParticipantMessage, fallback: string): string {
  const records = message.metadata?.teamMessages;
  if (!Array.isArray(records)) return fallback;
  return records.filter(record => record && typeof record === 'object').map(record => `${String(record.sender || record.senderId || 'System')}: ${String(record.text || '')}`).join('\n\n');
}

/** Project the private member transcript into the existing read-only renderer.
 * Results attach to their own call; none of these messages are interactive. */
export function participantChatMessages(messages: TeamParticipantMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const tools = new Map<string, ChatMessage>();
  const outputs = new Map<string, ToolResult>();
  for (const message of [...messages].sort(compareParticipantMessages)) {
    const blocks: CanonicalContentBlock[] = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.text ?? (typeof message.content === 'string' ? message.content : '') }];
    for (const [index, block] of blocks.entries()) {
      const base = { id: blocks.length === 1 ? message.id : `${message.id}:${index}`, turnId: message.turnId,
        timestamp: message.createdAt ?? message.timestamp ?? '', type: message.role === 'user' ? 'user' : 'assistant', isStreaming: message.isStreaming === true };
      if (block.type === 'text' || block.type === 'thinking') {
        const internal = message.metadata?.purpose === 'team_runtime' && message.metadata?.teamConsumed === true;
        const start = message.metadata?.teamInjectionMode === 'start';
        result.push({ ...base, ...(internal ? { type: start ? 'user' : 'system', isTeamInjection: !start } : {}), content: internal ? teamDisplayText(message, block.text) : block.text, isThinking: block.type === 'thinking',
          ...(internal && Array.isArray(message.metadata?.teamEventIds) ? { teamMessageIds: message.metadata.teamEventIds as string[] } : {}) });
      } else if (block.type === 'tool_call') {
        const row: ChatMessage = { ...base, type: 'assistant', content: '', isToolUse: true, toolId: block.id, toolCallId: block.id, toolName: block.name, toolInput: JSON.stringify(block.input, null, 2), toolResult: null };
        tools.set(block.id, row); result.push(row);
      } else if (block.type === 'tool_result' || block.type === 'tool_result_reference') {
        const content = block.type === 'tool_result_reference' ? block.preview : block.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        outputs.set(block.toolCallId, { content, isError: block.isError,
          ...(block.type === 'tool_result' ? { images: block.content.filter(item => item.type === 'image').map(image => ({ name: '', mimeType: image.mimeType, data: image.source === 'base64' ? `data:${image.mimeType};base64,${image.data}` : image.data })) } : {}) });
      } else if (block.type === 'image') {
        result.push({ ...base, content: '', images: [{ name: '', mimeType: block.mimeType, data: block.source === 'base64' ? `data:${block.mimeType};base64,${block.data}` : block.data }] });
      } else if (block.type === 'media_reference') {
        result.push({ ...base, content: block.preview });
      }
    }
  }
  for (const [id, output] of outputs) {
    const tool = tools.get(id);
    if (tool) tool.toolResult = output;
  }
  return result;
}

export function mergeParticipantMessages(previous: TeamParticipantMessage[], updates: TeamParticipantMessage[]) {
  const merged = new Map(previous.map(message => [message.id, message]));
  for (const message of updates) {
    const old = merged.get(message.id);
    const oldRevision = old?.timeline?.revision;
    const nextRevision = message.timeline?.revision;
    if (typeof oldRevision === 'number' && typeof nextRevision === 'number' && oldRevision > nextRevision) continue;
    merged.set(message.id, message);
  }
  return [...merged.values()].sort(compareParticipantMessages);
}
