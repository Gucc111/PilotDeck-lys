import type { PilotDeckElicitationAnswer } from '../tool/elicitation/PilotDeckElicitationChannel.js';
import type { TeamHumanInteractionStatus, TeamRuntimeCommand } from './runtimeTypes.js';
import { TeamError, text } from './validation.js';

export type TeamInteractionResponse = Omit<Extract<TeamRuntimeCommand, { action: 'runtime_interaction_respond' }>, 'action'>;
export type NormalizedTeamResponse = { status: TeamHumanInteractionStatus; resolution: unknown; answer?: PilotDeckElicitationAnswer };
const invalid = (message: string): never => { throw new TeamError('TEAM_INVALID_INPUT', message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate before claiming a waiter. Decision and elicitation payload must agree. */
export function normalizeTeamInteractionResponse(input: TeamInteractionResponse): NormalizedTeamResponse {
  for (const key of ['sessionKey', 'activationId', 'participantId', 'interactionId', 'requestId'] as const) text(input[key], key, { max: 500 });
  if (!Number.isSafeInteger(input.stopVersion) || input.stopVersion < 0) invalid('stopVersion must be a nonnegative integer.');
  if (input.reason !== undefined) text(input.reason, 'reason', { empty: true });
  if (input.kind === 'tool_permission') {
    if (!['allow', 'deny', 'cancel'].includes(input.decision ?? '') || input.answer !== undefined) invalid('Tool permission responses require allow, deny, or cancel without an answer.');
    return { status: input.decision === 'allow' ? 'allowed' : input.decision === 'deny' ? 'denied' : 'cancelled', resolution: input.decision };
  }
  if (input.kind !== 'user_question' && input.kind !== 'plan_approval') invalid('kind is invalid.');
  if (input.kind === 'user_question' && input.decision !== undefined && input.decision !== 'cancel') invalid('Question responses require an answer or cancel.');
  if (input.kind === 'plan_approval' && !['approve', 'decline', 'cancel'].includes(input.decision ?? '')) invalid('Plan responses require approve, decline, or cancel.');
  let answer: PilotDeckElicitationAnswer | undefined;
  if (input.answer !== undefined) {
    if (!record(input.answer)) invalid('answer must be an object.');
    const raw = input.answer as Record<string, unknown>;
    if (raw.type === 'cancelled') {
      if (Object.keys(raw).some(key => !['type', 'reason'].includes(key))) invalid('Cancelled answers cannot include answered values.');
      if (raw.reason !== undefined && typeof raw.reason !== 'string') invalid('Cancellation reason must be a string.');
      answer = { type: 'cancelled', ...(raw.reason ? { reason: String(raw.reason) } : {}) };
    } else {
      if (raw.type !== undefined && raw.type !== 'answered') invalid('answer.type is invalid.');
      const answers = raw.type === 'answered' ? raw.answers : raw;
      if (!record(answers) || !Object.keys(answers).length || Object.values(answers).some(value => typeof value !== 'string' && !(Array.isArray(value) && value.every(item => typeof item === 'string')))) invalid('Answers must contain strings or arrays of strings.');
      if (raw.type === 'answered' && Object.keys(raw).some(key => !['type', 'answers', 'annotations'].includes(key))) invalid('Unknown elicitation answer field.');
      if (raw.type === 'answered' && raw.annotations !== undefined) {
        if (!record(raw.annotations) || Object.values(raw.annotations).some(value => !record(value) || Object.entries(value).some(([key, item]) => !['preview', 'notes'].includes(key) || typeof item !== 'string'))) invalid('Answer annotations must contain preview/notes strings.');
      }
      answer = { type: 'answered', answers: structuredClone(answers) as Record<string, string | string[]>, ...(raw.type === 'answered' && raw.annotations ? { annotations: structuredClone(raw.annotations) as Record<string, { preview?: string; notes?: string }> } : {}) };
    }
  }
  if (input.decision === 'cancel') {
    if (answer?.type === 'answered') invalid('A cancel decision cannot contain an answered payload.');
    answer = answer ?? { type: 'cancelled', ...(input.reason ? { reason: input.reason } : {}) };
  }
  if (input.kind === 'plan_approval' && input.decision !== 'cancel') {
    const expected = input.decision === 'approve' ? 'execute_plan' : 'continue_planning';
    if (!answer) answer = { type: 'answered', answers: { 'What should happen next?': expected } };
    if (answer.type !== 'answered') invalid('Plan decision and answer disagree.');
    const values = Object.values((answer as Extract<PilotDeckElicitationAnswer, { type: 'answered' }>).answers).flat();
    if (!values.includes(expected) || values.some(value => value === (expected === 'execute_plan' ? 'continue_planning' : 'execute_plan'))) invalid('Plan decision and answer disagree.');
  }
  if (!answer) invalid('Question responses require an answer or cancel.');
  const finalAnswer = answer!;
  const status = finalAnswer.type === 'cancelled' ? 'cancelled' : input.kind === 'plan_approval' ? (input.decision === 'approve' ? 'approved' : 'declined') : 'answered';
  return { status, resolution: structuredClone(finalAnswer), answer: finalAnswer };
}
