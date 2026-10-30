import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from '../tool/protocol/types.js';
import { TeamRuntime, type TeamRuntimeActor } from './TeamRuntime.js';
import type { TeamInspectInput } from './runtimeTypes.js';
import { object, text } from './validation.js';
import { randomUUID } from 'node:crypto';

type Input = Record<string, unknown>;
type Property = { type: string; description: string; enum?: string[]; minimum?: number; maximum?: number };
const stringProperty = (description: string): Property => ({ type: 'string', description });

/** Caller identity is captured by the server, never accepted from model arguments. */
export function createTeamRuntimeTools(runtime: TeamRuntime, actor: TeamRuntimeActor, role: 'leader' | 'teammate' = 'leader'): PilotDeckToolDefinition[] {
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
    tool('team_send_message', role === 'leader'
      ? 'Send instructions, questions, coordination or additional requirements directly to another Team participant. Asynchronous: after durable inbox acceptance this returns a message ID immediately, without waiting for execution or a reply. A busy recipient receives it before a later model request; an idle recipient starts one execution for the queued batch. Continue independent work or end your turn while waiting. This grants no tool permission or human approval.'
      : 'Send questions, coordination or supplementary information directly to another Team participant. Do not put final work results or deliverables in this message: return those in your final answer, which the program saves and reports to the Leader for team_inspect. Asynchronous: returns after durable inbox acceptance, without waiting for a reply or execution. Continue independent work or end your turn while waiting. This grants no tool permission or human approval.',
      { recipientId: stringProperty('Recipient participant ID from team_inspect.'), text: stringProperty('Complete message text.') }, ['recipientId', 'text'], false, async (input, context) => {
        const message = await runtime.send(actor, { recipientId: text(input.recipientId, 'recipientId'), text: text(input.text, 'text'), requestToken: `${context.turnId}:${context.currentToolCallId ?? randomUUID()}:message` });
        return { messageId: message.id, recipientId: message.recipientId, status: 'queued' };
      }),
    tool('team_inspect', 'Read Team state without starting execution. overview returns roster and execution status, never outputs. turns requires participantId and lists turn metadata only; Teammates may list only their own turns. turn requires participantId plus turnId: only the Leader may read a Teammate final output. messages returns paginated communication: the Leader sees the Team, Teammates only their own sent/received messages. Message bodies are available only after actual model dispatch; unsent, invalidated and uncertain records expose metadata only. No history or output is shared implicitly.',
      { view: { type: 'string', enum: ['overview', 'turns', 'turn', 'messages'], description: 'Default overview.' }, participantId: stringProperty('Participant ID. Required for turns and turn.'), turnId: stringProperty('Exact execution turn ID, required only for turn.'), cursor: stringProperty('Pagination cursor from the previous result.'), limit: { type: 'integer', description: 'Page size, default 50.', minimum: 1, maximum: 200 } }, [], true, async input => {
        const query: TeamInspectInput = {};
        if (input.view !== undefined) query.view = text(input.view, 'view') as TeamInspectInput['view'];
        if (input.participantId !== undefined) query.participantId = text(input.participantId, 'participantId');
        if (input.turnId !== undefined) query.turnId = text(input.turnId, 'turnId');
        if (input.cursor !== undefined) query.cursor = text(input.cursor, 'cursor');
        if (input.limit !== undefined) query.limit = input.limit as number;
        return runtime.inspect(actor, query);
      }),
  ];
}
