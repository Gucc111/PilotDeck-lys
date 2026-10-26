import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from '../tool/protocol/types.js';
import { TeamRuntime, type TeamRuntimeActor } from './TeamRuntime.js';
import { object, text } from './validation.js';
import { randomUUID } from 'node:crypto';

type Input = Record<string, unknown>;
const stringProperty = (description: string) => ({ type: 'string' as const, description });
const optional = (value: unknown, field: string) => value === undefined ? undefined : text(value, field);
const token = (context: PilotDeckToolRuntimeContext, name: string, input: Input) => optional(input.requestToken, 'requestToken') ?? `${context.turnId}:${context.currentToolCallId ?? randomUUID()}:${name}`;

/** Actor identity comes from the session factory, never model-supplied arguments. */
export function createTeamRuntimeTools(runtime: TeamRuntime, actor: TeamRuntimeActor): PilotDeckToolDefinition[] {
  const tool = (name: string, description: string, properties: Record<string, ReturnType<typeof stringProperty>>, required: string[], readOnly: boolean, execute: (input: Input, context: PilotDeckToolRuntimeContext) => Promise<unknown>): PilotDeckToolDefinition => ({
    name, description, kind: 'custom', alwaysLoad: true,
    inputSchema: { type: 'object', additionalProperties: false, properties, required },
    isReadOnly: () => readOnly, isConcurrencySafe: () => true,
    checkPermissions: async (_input, context) => {
      // Coordination changes only this activation's journal. Files/commands
      // still pass through each receiving participant's existing approvals.
      // Tool-level allow precedes mode checks, so preserve plan explicitly.
      if (!readOnly && context.permissionContext.mode === 'plan') return { type: 'deny', message: 'Plan mode does not start or modify Team work.', reason: { type: 'mode', mode: 'plan', message: 'Plan mode does not start or modify Team work.' } };
      return { type: 'allow', reason: { type: 'tool', toolName: name, message: 'Team coordination is admitted without granting permission for participant tools.' } };
    },
    execute: async (input, context) => {
      const checked = object(input, name, Object.keys(properties));
      const result = await execute(checked, context);
      return { content: [{ type: 'json', value: result }], data: result };
    },
  });
  return [
    tool('team_inspect', 'Read this Team roster, work status, and messages visible to you. Teammates cannot read sibling work or the Leader conversation. Messages intended for a peer must be explicitly relayed by the Leader. This grants no approval or permission authority.', {}, [], true, async () => runtime.inspect(actor)),
    tool('team_delegate', 'Leader only: asynchronously assign a self-contained task to one configured Teammate. Include any context it needs; it cannot see the Leader conversation. Returns durable admission immediately. Different Teammates run in parallel; each Teammate processes its work serially. Use team_collect when completion is reported.', {
      participantId: stringProperty('Target Teammate ID from team_inspect.'), task: stringProperty('Complete task description.'), context: stringProperty('Explicit background relevant to this task.'), requestToken: stringProperty('Optional stable retry token. Reusing it with changed content fails.'),
    }, ['participantId', 'task'], false, async (input, context) => runtime.delegate(actor, { participantId: text(input.participantId, 'participantId'), task: text(input.task, 'task'), context: optional(input.context, 'context'), requestToken: token(context, 'delegate', input) })),
    tool('team_followup', 'Leader only: admit additional collectible work to the same Teammate using its previous execution context. Distinct from an ordinary coordination message. Does not wait for completion.', {
      participantId: stringProperty('Target Teammate ID.'), workId: stringProperty('Previous work for this Teammate.'), task: stringProperty('New work to perform.'), context: stringProperty('Additional background.'), requestToken: stringProperty('Optional stable retry token.'),
    }, ['participantId', 'workId', 'task'], false, async (input, context) => runtime.delegate(actor, { participantId: text(input.participantId, 'participantId'), task: text(input.task, 'task'), context: optional(input.context, 'context'), followupOf: text(input.workId, 'workId'), requestToken: token(context, 'followup', input) })),
    tool('team_collect', 'Read the durable status and result of admitted work. This is a pure read: it never starts or repeats work. Only the Leader and the assigned Teammate can read it.', { workId: stringProperty('Work ID returned by team_delegate or team_followup.') }, ['workId'], true, async input => runtime.collect(actor, text(input.workId, 'workId'))),
    tool('team_send_message', 'Send non-blocking questions, progress, supplementary information, or coordination text. Do not send final deliverables here: return the final result from your delegated task; it is stored for the Leader to read with team_collect. Receipt means inbox acceptance, not a reply or completed work. A Teammate message addressed to another Teammate is delivered to the Leader with its intended recipient preserved, awaiting explicit relay. Does not delegate tasks or approve actions.', {
      recipientId: stringProperty('Recipient participant ID from team_inspect.'), text: stringProperty('Message text.'), replyTo: stringProperty('Message ID being answered.'), workId: stringProperty('Related work ID.'), requestToken: stringProperty('Optional stable retry token.'),
    }, ['recipientId', 'text'], false, async (input, context) => {
      const message = await runtime.send(actor, { recipientId: text(input.recipientId, 'recipientId'), text: text(input.text, 'text'), replyTo: optional(input.replyTo, 'replyTo'), workId: optional(input.workId, 'workId'), requestToken: token(context, 'message', input) });
      return { message, delivery: message.recipientId === message.intendedRecipientId ? 'inbox_accepted' : 'awaiting_leader_relay' };
    }),
    tool('team_relay_message', 'Leader only: explicitly relay a received message to its intended Teammate, optionally changing the text or recipient. Preserves the original sender and relay reference. Inspect messages before forwarding; this conveys no approval authority.', {
      messageId: stringProperty('Received message ID.'), text: stringProperty('Optional revised text including useful Leader context.'), recipientId: stringProperty('Optional replacement recipient from this Team.'), requestToken: stringProperty('Optional stable retry token.'),
    }, ['messageId'], false, async (input, context) => runtime.relay(actor, { messageId: text(input.messageId, 'messageId'), text: optional(input.text, 'text'), recipientId: optional(input.recipientId, 'recipientId'), requestToken: token(context, 'relay', input) })),
    tool('team_wait_for_information', 'Assigned Teammate only: mark your current work as waiting for information after sending a question. End your turn after this call. A later incoming message resumes the same work with your existing context. This does not block a tool call or hold a runtime lock.', { workId: stringProperty('Your currently executing work ID.') }, ['workId'], false, async input => runtime.waitForInformation(actor, text(input.workId, 'workId'))),
  ];
}
