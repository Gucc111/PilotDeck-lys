import type { TeamRuntimeActivation, TeamHumanInteraction as RuntimeTeamHumanInteraction } from '../../../../src/team/runtimeTypes';

/**
 * UI copy of the durable Team human-interaction record.  The gateway owns the
 * record; keeping this shape local makes the UI tolerant of older activations
 * (where `interactions` was not persisted yet).
 */
export type TeamInteractionKind = RuntimeTeamHumanInteraction['kind'];
export type TeamInteractionStatus = RuntimeTeamHumanInteraction['status'];
export type TeamHumanInteraction = RuntimeTeamHumanInteraction;

export type TeamRuntimeActivationWithInteractions = TeamRuntimeActivation & {
  interactions?: TeamHumanInteraction[];
};

export function activationInteractions(activation: TeamRuntimeActivation | null | undefined): TeamHumanInteraction[] {
  const value = (activation as TeamRuntimeActivationWithInteractions | null | undefined)?.interactions;
  return Array.isArray(value) ? value : [];
}

export function interactionRequestInput(interaction: TeamHumanInteraction): unknown {
  const request = interaction.request;
  if (!request || typeof request !== 'object') return request;
  const value = request as Record<string, unknown>;

  // Permission events use `payload`, while the normalized chat permission
  // shape uses `input`.  Prefer the actual tool arguments so the Team card
  // does not expose the gateway event envelope as if it were tool input.
  if ('input' in value) return value.input;
  if ('payload' in value) return value.payload;

  // Elicitation events keep their questions and plan metadata at the event
  // root.  The ordinary interactive renderers expect both at `input`, so
  // project the small, renderable snapshot while dropping transport fields.
  if ('questions' in value || 'metadata' in value) {
    const metadata = value.metadata && typeof value.metadata === 'object'
      ? value.metadata as Record<string, unknown>
      : {};
    return {
      ...metadata,
      ...('questions' in value ? { questions: value.questions } : {}),
    };
  }
  return request;
}

export function interactionToolName(interaction: TeamHumanInteraction): string {
  if (interaction.toolName) return interaction.toolName;
  if (interaction.kind === 'user_question') return 'ask_user_question';
  if (interaction.kind === 'plan_approval') return 'exit_plan_mode';
  return 'tool';
}
