import type { CanonicalContentBlock } from '../../../../src/model/protocol/canonical';
import type { TeamParticipantMessage } from '../../../../src/team/runtimeTypes';
import type { ChatMessage, ToolResult } from '../chat/types/types';

/** Project the private member transcript into the existing read-only renderer.
 * Results attach to their own call; none of these messages are interactive. */
export function participantChatMessages(messages: TeamParticipantMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const tools = new Map<string, ChatMessage>();
  const outputs = new Map<string, ToolResult>();
  for (const message of messages) {
    const blocks: CanonicalContentBlock[] = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.text ?? (typeof message.content === 'string' ? message.content : '') }];
    for (const [index, block] of blocks.entries()) {
      const base = { id: blocks.length === 1 ? message.id : `${message.id}:${index}`, turnId: message.turnId,
        timestamp: message.createdAt ?? message.timestamp ?? '', type: message.role === 'user' ? 'user' : 'assistant', isStreaming: message.isStreaming === true };
      if (block.type === 'text' || block.type === 'thinking') {
        result.push({ ...base, content: block.text, isThinking: block.type === 'thinking' });
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
  for (const message of updates) merged.set(message.id, message);
  return [...merged.values()];
}
