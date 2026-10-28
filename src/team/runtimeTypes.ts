import type { AgentProfile, ProfileRef, TeamDefinition, TeamModel } from './types.js';

export type TeamRuntimeIssue = { severity: 'error' | 'warning'; code: string; message: string; participantId?: string };
export type TeamRuntimeParticipant = {
  id: string;
  role: 'leader' | 'teammate';
  profile: AgentProfile;
  projectKey: string;
  projectPath?: string;
  model: TeamModel;
  capabilities: { tools: string[]; skills: string[]; mcpServers: string[] };
};
export type TeamRuntimeProbe = {
  team: TeamDefinition;
  projectKey: string;
  participants: TeamRuntimeParticipant[];
  issues: TeamRuntimeIssue[];
  fingerprint: string;
  compatible: boolean;
};
export type TeamWorkStatus = 'queued' | 'running' | 'waiting_information' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'stopped';
export type TeamRuntimeWork = {
  id: string; stopVersion: number; participantId: string; task: string; context?: string; followupOf?: string;
  status: TeamWorkStatus; createdAt: string; startedAt?: string; endedAt?: string;
  result?: string; error?: string; owner?: { pid: number; instanceId: string; executionId?: string };
};
export type TeamRuntimeMessage = {
  id: string; stopVersion: number; senderId: string; recipientId: string; intendedRecipientId: string; text: string;
  replyTo?: string; relayOf?: string; workId?: string; createdAt: string;
  status: 'queued' | 'delivered' | 'interrupted' | 'stopped'; deliveredAt?: string; invalidatedAt?: string;
  batchId?: string;
  owner?: { pid: number; instanceId: string; executionId?: string };
};
export type TeamRuntimeNotification = {
  id: string; stopVersion: number; kind: 'work_completed' | 'work_failed' | 'message';
  workId?: string; messageId?: string; participantId: string; summary: string;
  createdAt: string; deliveredAt?: string; cancelledAt?: string;
  owner?: { pid: number; instanceId: string; executionId?: string };
  /** Stable delivery batch identity survives acceptance-response loss and restart. */
  batchId?: string;
};
export type TeamHumanInteractionKind = 'tool_permission' | 'user_question' | 'plan_approval';
export type TeamHumanInteractionStatus = 'pending' | 'allowed' | 'denied' | 'answered' | 'approved' | 'declined' | 'cancelled' | 'expired' | 'failed';
/** Durable human-facing request raised by a Teammate. */
export type TeamHumanInteraction = {
  id: string;
  requestId: string;
  activationId: string;
  sessionKey: string;
  stopVersion: number;
  participantId: string;
  participantDisplayName: string;
  kind: TeamHumanInteractionKind;
  toolName?: string;
  toolCallId?: string;
  request: unknown;
  workId?: string;
  turnId?: string;
  status: TeamHumanInteractionStatus;
  createdAt: string;
  resolvedAt?: string;
  resolution?: unknown;
  error?: string;
};
export type TeamRuntimeActivation = {
  id: string; sessionKey: string; storageProjectKey?: string; projectKey: string;
  team: TeamDefinition; participants: TeamRuntimeParticipant[]; probeFingerprint: string;
  status: 'active' | 'stopping' | 'stopped' | 'closed'; createdAt: string; updatedAt: string;
  works: TeamRuntimeWork[]; messages: TeamRuntimeMessage[]; notifications: TeamRuntimeNotification[];
  /** Persisted requests requiring direct human interaction with Teammates. */
  interactions: TeamHumanInteraction[];
  automaticWakeups: number;
  /** Incremented by stop, fencing an input whose preflight began earlier. */
  stopVersion: number;
  stopFromVersion?: number;
  stopReason?: 'abort' | 'restart';
  runtimeOwner?: { pid: number; instanceId: string };
  cleanup?: { startedAt: string; pending: string[]; timedOut?: boolean; error?: string };
};
export type TeamRuntimeView = { activation: TeamRuntimeActivation | null; history?: TeamRuntimeActivation[]; continuationPaused?: 'budget'; interactionsNextCursor?: string };
export type TeamRuntimeCommand =
  | { action: 'runtime_probe'; team: ProfileRef; sessionKey?: string; storageProjectKey?: string; projectKey?: string }
  | { action: 'runtime_select'; sessionKey: string; storageProjectKey?: string; team: ProfileRef | null; projectKey?: string; requestToken: string; probeFingerprint?: string }
  | { action: 'runtime_get'; sessionKey: string; cursor?: string; limit?: number }
  | { action: 'runtime_stop'; sessionKey: string; activationId: string; stopVersion: number }
  | { action: 'runtime_interaction_respond'; sessionKey: string; activationId: string; stopVersion: number; participantId: string; interactionId: string; requestId: string; kind: TeamHumanInteractionKind; decision?: 'allow' | 'deny' | 'approve' | 'decline' | 'cancel'; answer?: unknown; reason?: string }
  | { action: 'runtime_participant_messages'; sessionKey: string; activationId: string; stopVersion: number; participantId: string; cursor?: string; limit?: number };
export type TeamRuntimeCommandResult = TeamRuntimeProbe | TeamRuntimeView | TeamRuntimeInteractionResponse | TeamRuntimeParticipantMessages;
export type TeamRuntimeInteractionResponse = { interaction: TeamHumanInteraction; delivered: boolean };
/** Read-only projection of a Teammate's private transcript.  It deliberately
 * contains no filesystem paths or internal session identifiers. */
export type TeamParticipantMessage = {
  id: string;
  role?: string;
  content?: unknown;
  text?: string;
  createdAt?: string;
  timestamp?: string;
  type?: string;
  isStreaming?: boolean;
  turnId?: string;
};
export type TeamRuntimeParticipantMessages = { sessionKey: string; activationId: string; participantId: string; messages: TeamParticipantMessage[]; nextCursor?: string; streaming?: boolean; stopVersion?: number; streamEpoch?: string; revision?: number };
export type TeamExecutionSelection = { team: ProfileRef; projectKey?: string; requestToken: string; probeFingerprint?: string };
export type TeamParticipantExecution = {
  activation: TeamRuntimeActivation; participant: TeamRuntimeParticipant;
  work?: TeamRuntimeWork; messages?: TeamRuntimeMessage[]; signal: AbortSignal; executionId: string;
  /** Confirm the message batch only after its input was durably accepted. */
  acceptMessages: () => Promise<void>;
  updateStatus: (status: 'running' | 'waiting_information' | 'waiting_approval') => Promise<void>;
};
export type TeamRuntimeOptions = {
  pilotHome: string;
  resolveTeam: (ref: ProfileRef) => Promise<TeamDefinition>;
  probe: (team: TeamDefinition, projectKey?: string, context?: { sessionKey?: string; storageProjectKey?: string }) => Promise<{
    projectKey: string; participants: TeamRuntimeParticipant[]; issues: TeamRuntimeIssue[]; environmentFingerprint: string;
  }>;
  executeParticipant: (input: TeamParticipantExecution) => Promise<{ text: string }>;
  /** Short local recheck while holding the shared project/reference lock; never connect MCP here. */
  validateSelection?: (probe: TeamRuntimeProbe, context: { sessionKey: string; storageProjectKey?: string }) => Promise<void>;
  notifyLeader: (input: { activation: TeamRuntimeActivation; notifications: TeamRuntimeNotification[]; signal: AbortSignal; allowStartTurn: boolean }) => Promise<boolean | { delivered: boolean; startedTurn?: boolean }>;
  /** Return true only after a busy member's steer is durably applied. */
  deliverParticipantMessages?: (input: { activation: TeamRuntimeActivation; participant: TeamRuntimeParticipant; messages: TeamRuntimeMessage[]; signal: AbortSignal }) => Promise<boolean>;
  /** Read the private Teammate transcript through a server-owned projection. */
  readParticipantMessages?: (input: { activation: TeamRuntimeActivation; participant: TeamRuntimeParticipant; cursor?: string; limit?: number }) => Promise<TeamRuntimeParticipantMessages>;
  isLeaderBusy?: (sessionKey: string) => boolean;
  stopLeader?: (sessionKey: string) => Promise<void>;
  /** Runs after every executing producer exits, including late-created resources. */
  finishCleanup?: (activation: TeamRuntimeActivation) => Promise<void>;
  maxAutomaticWakeups?: number;
  stopTimeoutMs?: number;
};
