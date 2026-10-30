import type { CanonicalMessage } from '../model/index.js';
import type { AgentTranscriptEntry } from '../session/transcript/TranscriptEntry.js';

/** Old delivery acknowledgements cannot prove that summaries contain only consumed input. */
export function teamModelHistory(entries: AgentTranscriptEntry[], current: { activationId: string; stopVersion: number }): AgentTranscriptEntry[] {
  let contaminated = -1;
  let legacyTeamSeen = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const newInput = entry.type === 'accepted_input' && entry.metadata?.teamCommunicationVersion === 3;
    if (entry.type === 'accepted_input' && entry.metadata?.teamActivationId && !newInput) contaminated = index;
    if (newInput) legacyTeamSeen = false;
    if (entry.type === 'accepted_input' && entry.metadata?.teamActivationId && !newInput) legacyTeamSeen = true;
    const placeholder = entry.type === 'accepted_input' && entry.metadata?.purpose === 'team_runtime_wakeup';
    const messages = entry.type === 'accepted_input' ? entry.messages
      : 'message' in entry ? [entry.message]
        : entry.type === 'control_boundary' && 'snapshot' in entry.boundary ? entry.boundary.snapshot?.messages ?? [] : [];
    if (!placeholder && messages.some(unprovenTeamMessage)) contaminated = index;
    if (legacyTeamSeen && entry.type === 'control_boundary' && entry.boundary.kind === 'compact') contaminated = index;
  }
  if (contaminated < 0) return entries;
  const safeStart = entries.findIndex((entry, index) => index > contaminated && entry.type === 'accepted_input'
    && entry.metadata?.teamCommunicationVersion === 3 && entry.metadata.teamActivationId === current.activationId
    && entry.metadata.teamStopVersion === current.stopVersion);
  return safeStart < 0 ? [] : entries.slice(safeStart);
}

function unprovenTeamMessage(message: CanonicalMessage): boolean {
  return message.metadata?.purpose === 'team_runtime' && message.metadata.teamConsumed !== true;
}
