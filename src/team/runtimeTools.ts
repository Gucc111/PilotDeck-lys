import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from '../tool/protocol/types.js';
import { TeamRuntime, type TeamRuntimeActor } from './TeamRuntime.js';
import type { TeamMessagesInput, TeamTurnsInput } from './runtimeTypes.js';
import { object, text } from './validation.js';
import { randomUUID } from 'node:crypto';

type Input = Record<string, unknown>;
type Property = { type: string; description: string; enum?: string[]; minimum?: number; maximum?: number };
const stringProperty = (description: string): Property => ({ type: 'string', description });

/** Caller identity is captured by the server, never accepted from model arguments. */
export function createTeamRuntimeTools(runtime: TeamRuntime, actor: TeamRuntimeActor, _role: 'leader' | 'teammate' = 'leader'): PilotDeckToolDefinition[] {
  const tool = (name: string, description: string, properties: Record<string, Property>, required: string[], readOnly: boolean, execute: (input: Input, context: PilotDeckToolRuntimeContext) => Promise<unknown>): PilotDeckToolDefinition => ({
    name, description, kind: 'custom', alwaysLoad: true,
    inputSchema: { type: 'object', additionalProperties: false, properties, required },
    isReadOnly: () => readOnly, isConcurrencySafe: () => true,
    checkPermissions: async (_input, context) => {
      if (!readOnly && context.permissionContext.mode === 'plan') return { type: 'deny', message: 'Plan mode does not start or modify Team execution.', reason: { type: 'mode', mode: 'plan', message: 'Plan mode does not start or modify Team execution.' } };
      return { type: 'allow', reason: { type: 'tool', toolName: name, message: 'Team communication does not grant permission for recipient tools.' } };
    },
    execute: async (input, context) => {
      const checked = object(input, name, Object.keys(properties));
      const result = await execute(checked, context);
      return { content: [{ type: 'json', value: result }], data: result };
    },
  });
  return [
    tool('team_roster', 'Read the current Team roster without starting execution. Returns only each participant id, role, display name, effective status and latest turn id. Use the participant id when sending a message or querying a Teammate turn.', {}, [], true, async () => runtime.roster(actor)),
    tool('team_send_message', 'Send a message to another Team participant. The server supplies the sender identity. This asynchronous operation returns after durable queueing and does not wait for delivery, execution or a reply. Plan mode rejects this state-changing operation.', { recipientId: stringProperty('Recipient participant id from team_roster.'), text: stringProperty('Complete message text.') }, ['recipientId', 'text'], false, async (input, context) => {
      const message = await runtime.send(actor, { recipientId: text(input.recipientId, 'recipientId'), text: text(input.text, 'text'), requestToken: `${context.turnId}:${context.currentToolCallId ?? randomUUID()}:message` });
      return { messageId: message.id, status: 'queued' };
    }),
    tool('team_messages', 'Read Team messages without starting execution. Pass messageId for one exact message, or cursor and limit for a page. Pages default to 5 and return newest messages first. Leader can read all messages; Teammates can read only messages they sent or received. Pages show only normal communication records (queued, preparing, sending, consumed and delivered) and hide deleted, invalidated, uncertain and other abnormal statuses. Pass messageId to inspect one exact record, including its full body and abnormal status.', { messageId: stringProperty('Exact message id. Do not combine with cursor or limit.'), cursor: stringProperty('Opaque cursor returned by the previous page.'), limit: { type: 'integer', description: 'Page size, default 5.', minimum: 1, maximum: 200 } }, [], true, async input => {
      const query: TeamMessagesInput = {};
      if (input.messageId !== undefined) query.messageId = text(input.messageId, 'messageId');
      if (input.cursor !== undefined) query.cursor = text(input.cursor, 'cursor');
      if (input.limit !== undefined) query.limit = input.limit as number;
      return runtime.messages(actor, query);
    }),
    tool('team_turns', 'Read Teammate turns without starting execution. participantId is required. Pass turnId for one exact turn, or cursor and limit for a page. Pages default to 5 and return newest turns first. Leader may read any Teammate; a Teammate may read another Teammate. No participant may read its own turn or a Leader turn. Exact ended turns may include the final assistant text; active turns never include finalMessage.', { participantId: stringProperty('Required Teammate participant id.'), turnId: stringProperty('Exact turn id. Do not combine with cursor or limit.'), cursor: stringProperty('Opaque cursor returned by the previous page.'), limit: { type: 'integer', description: 'Page size, default 5.', minimum: 1, maximum: 200 } }, ['participantId'], true, async input => {
      const query: TeamTurnsInput = { participantId: text(input.participantId, 'participantId') };
      if (input.turnId !== undefined) query.turnId = text(input.turnId, 'turnId');
      if (input.cursor !== undefined) query.cursor = text(input.cursor, 'cursor');
      if (input.limit !== undefined) query.limit = input.limit as number;
      return runtime.turns(actor, query);
    }),
  ];
}
