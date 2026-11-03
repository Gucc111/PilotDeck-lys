import { randomUUID } from 'node:crypto';
import { TeamStore, hash } from './store.js';
import { TeamError, object, text } from './validation.js';
import { TeamRuntimeStore, type RuntimeState } from './runtimeStore.js';
import { normalizeTeamInteractionResponse, type NormalizedTeamResponse } from './humanInteraction.js';
import type { ProfileRef } from './types.js';
import type { AgentTurnResult } from '../agent/protocol/result.js';
import type { TeamHumanInteraction, TeamHumanInteractionKind, TeamMessageDeleteResult, TeamMessagesInput, TeamMessageProjection, TeamMessagesResult, TeamRosterResult, TeamRuntimeActivation, TeamRuntimeCommand, TeamRuntimeCommandResult, TeamRuntimeInteractionResponse, TeamRuntimeMessage, TeamRuntimeOptions, TeamRuntimeParticipantMessages, TeamRuntimeProbe, TeamRuntimeTurn, TeamRuntimeView, TeamRuntimeWork, TeamTurnsInput, TeamTurnsResult, TeamTurnProjection } from './runtimeTypes.js';

export type TeamRuntimeActor = { sessionKey: string; activationId: string; participantId: string; stopVersion: number };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const liveInstances = new Set<string>();
const pending = (work: TeamRuntimeWork) => ['queued', 'running', 'waiting_information', 'waiting_approval'].includes(work.status);
const pendingMessage = (message: TeamRuntimeMessage) => message.status === 'queued' || message.status === 'preparing';
const liveTurn = (turn: TeamRuntimeTurn) => ['preparing', 'running', 'waiting_approval'].includes(turn.status);
const fail = (code: string, message: string): never => { throw new TeamError(code, message); };

function ref(value: unknown): ProfileRef {
  const item = object(value, 'team', ['id']);
  return { id: text(item.id, 'team.id', { max: 200 }) };
}
export function validateRuntimeCommand(input: TeamRuntimeCommand): TeamRuntimeCommand {
  const action = (input as { action?: unknown })?.action;
  const allowed = action === 'runtime_probe' ? ['action', 'team', 'sessionKey', 'storageProjectKey', 'projectKey']
    : action === 'runtime_select' ? ['action', 'team', 'sessionKey', 'storageProjectKey', 'projectKey', 'requestToken', 'probeFingerprint']
      : action === 'runtime_get' ? ['action', 'sessionKey', 'cursor', 'limit', 'messageCursor', 'turnCursor'] : action === 'runtime_stop' ? ['action', 'sessionKey', 'activationId', 'stopVersion']
        : action === 'runtime_interaction_respond' ? ['action', 'sessionKey', 'activationId', 'stopVersion', 'participantId', 'interactionId', 'requestId', 'kind', 'decision', 'answer', 'reason']
          : action === 'runtime_participant_messages' ? ['action', 'sessionKey', 'activationId', 'stopVersion', 'participantId', 'cursor', 'limit']
            : action === 'runtime_message_delete' ? ['action', 'sessionKey', 'activationId', 'stopVersion', 'participantId', 'messageId'] : [];
  if (!allowed.length) fail('TEAM_INVALID_INPUT', 'Unknown Team runtime command.');
  const data = object(input, 'command', allowed);
  for (const key of ['sessionKey', 'storageProjectKey', 'projectKey', 'requestToken', 'probeFingerprint']) if (data[key] !== undefined) text(data[key], key, { max: 500 });
  if (action !== 'runtime_probe' || data.sessionKey !== undefined) text(data.sessionKey, 'sessionKey', { max: 500 });
  if (action === 'runtime_get') { for (const key of ['cursor', 'messageCursor', 'turnCursor']) if (data[key] !== undefined) text(data[key], key, { max: 100 }); if (data.limit !== undefined && (!Number.isSafeInteger(data.limit) || Number(data.limit) < 1 || Number(data.limit) > 200)) fail('TEAM_INVALID_INPUT', 'limit must be between 1 and 200.'); }
  if (action === 'runtime_stop') { text(data.activationId, 'activationId', { max: 500 }); if (!Number.isSafeInteger(data.stopVersion) || Number(data.stopVersion) < 0) fail('TEAM_INVALID_INPUT', 'stopVersion must be a nonnegative integer.'); }
  if (action === 'runtime_message_delete') {
    for (const key of ['activationId', 'participantId', 'messageId']) text(data[key], key, { max: 500 });
    if (!Number.isSafeInteger(data.stopVersion) || Number(data.stopVersion) < 0) fail('TEAM_INVALID_INPUT', 'stopVersion must be a nonnegative integer.');
  }
  if (action === 'runtime_interaction_respond' || action === 'runtime_participant_messages') {
    for (const key of ['activationId', 'participantId']) text(data[key], key, { max: 500 });
    if (data.cursor !== undefined) text(data.cursor, 'cursor', { max: 500 });
    if (action === 'runtime_interaction_respond') { for (const key of ['interactionId', 'requestId']) text(data[key], key, { max: 500 }); if (data.reason !== undefined) text(data.reason, 'reason', { empty: true }); }
    if (!Number.isSafeInteger(data.stopVersion) || Number(data.stopVersion) < 0) fail('TEAM_INVALID_INPUT', 'stopVersion must be a nonnegative integer.');
    if (action === 'runtime_interaction_respond' && !['tool_permission', 'user_question', 'plan_approval'].includes(String(data.kind))) fail('TEAM_INVALID_INPUT', 'kind is invalid.');
    if (action === 'runtime_interaction_respond' && data.decision !== undefined && !['allow', 'deny', 'approve', 'decline', 'cancel'].includes(String(data.decision))) fail('TEAM_INVALID_INPUT', 'decision is invalid.');
    if (action === 'runtime_participant_messages' && data.limit !== undefined && (!Number.isSafeInteger(data.limit) || Number(data.limit) < 1 || Number(data.limit) > 200)) fail('TEAM_INVALID_INPUT', 'limit must be between 1 and 200.');
  }
  if (action === 'runtime_select') text(data.requestToken, 'requestToken', { max: 500 });
  if (action === 'runtime_probe' || (action === 'runtime_select' && data.team !== null)) ref(data.team);
  return clone(input);
}

/** All durable mutations are short. No storage lock is held while a model or tool runs. */
export class TeamRuntime {
  private readonly store: TeamRuntimeStore;
  private readonly libraryLock: TeamStore;
  private readonly instanceId = randomUUID();
  private readonly ready: Promise<void>;
  private readonly controllers = new Map<string, AbortController>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly stopOperations = new Map<string, Promise<void>>();
  private readonly storageOperations = new Set<Promise<unknown>>();
  /** A consumed waiter is never replayed, even if its result write temporarily fails. */
  private readonly interactionReceipts = new Map<string, TeamHumanInteraction>();
  private disposed = false;

  constructor(private readonly options: TeamRuntimeOptions) {
    this.store = new TeamRuntimeStore(options.pilotHome);
    this.libraryLock = new TeamStore(options.pilotHome);
    liveInstances.add(this.instanceId);
    this.ready = this.recover();
    // Ordinary Gateway construction is synchronous; surface recovery failures on
    // explicit runtime access without an unhandled rejection during shutdown.
    void this.ready.catch(() => {});
  }
  async execute(input: TeamRuntimeCommand): Promise<TeamRuntimeCommandResult> {
    const command = validateRuntimeCommand(input);
    await this.ready;
    switch (command.action) {
      case 'runtime_probe': return this.probe(command.team, command.projectKey, command);
      case 'runtime_select': return this.select(command);
      case 'runtime_get': return this.getPage(command);
      case 'runtime_stop': return this.stop(command.sessionKey, command);
      case 'runtime_interaction_respond': throw new TeamError('TEAM_INTERACTION_CHANNEL_REQUIRED', 'Respond through the Team human interaction channel.');
      case 'runtime_participant_messages': return this.participantMessages(command);
      case 'runtime_message_delete': return this.deleteMessage(command);
    }
  }
  async probe(teamRef: ProfileRef, projectKey?: string, context?: { sessionKey?: string; storageProjectKey?: string }): Promise<TeamRuntimeProbe> {
    ref(teamRef);
    if (projectKey !== undefined) text(projectKey, 'projectKey', { max: 500 });
    const team = await this.options.resolveTeam(teamRef);
    const result = await this.options.probe(clone(team), projectKey, context);
    return { team, projectKey: result.projectKey, participants: result.participants, issues: result.issues, compatible: result.issues.length === 0, fingerprint: hash({ team, ...result, storageProjectKey: context?.storageProjectKey }) };
  }
  async get(sessionKey: string, cursor?: string, limit = 200): Promise<TeamRuntimeView> {
    await this.ready;
    const state = await this.store.read();
    const activation = state.sessions[sessionKey] ? state.activations[state.sessions[sessionKey]!] : null;
    const history = Object.values(state.activations).filter(a => a.sessionKey === sessionKey && a.id !== activation?.id).reverse();
    const visible = clone(activation ?? null);
    let interactionsNextCursor: string | undefined;
    if (visible) {
      const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
      const all = visible.interactions ?? [];
      visible.interactions = all.slice(offset, offset + limit);
      if (offset + visible.interactions.length < all.length) interactionsNextCursor = String(offset + visible.interactions.length);
    }
    return { activation: visible, ...(history.length ? { history: clone(history) } : {}), ...(interactionsNextCursor ? { interactionsNextCursor } : {}) };
  }
  private async getPage(command: Extract<TeamRuntimeCommand, { action: 'runtime_get' }>): Promise<TeamRuntimeView> {
    const view = await this.get(command.sessionKey, command.cursor, command.limit);
    if (!view.activation) return view;
    const limit = command.limit ?? 200;
    for (const [field, cursor, next] of [['messages', command.messageCursor, 'messagesNextCursor'], ['turns', command.turnCursor, 'turnsNextCursor']] as const) {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) fail('TEAM_INVALID_INPUT', `${field} cursor is invalid.`);
      const items = view.activation[field] ?? [];
      if (offset + limit < items.length) view[next] = String(offset + limit);
      if (field === 'messages') view.activation.messages = (items as TeamRuntimeMessage[]).slice(offset, offset + limit).filter(message => message.status !== 'deleted');
      else view.activation.turns = view.activation.turns?.slice(offset, offset + limit);
    }
    return view;
  }
  async projectReferences(projectKey: string): Promise<boolean> {
    await this.ready;
    const state = await this.store.read();
    return Object.values(state.activations).some(a => a.projectKey === projectKey || a.storageProjectKey === projectKey || a.participants.some(p => p.projectKey === projectKey));
  }
  async assertActivation(sessionKey: string, activationId: string | null | undefined, expectedStopVersion?: number): Promise<TeamRuntimeActivation | null> {
    const { activation } = await this.get(sessionKey);
    if (activationId !== undefined && (activation?.id ?? null) !== activationId) fail('TEAM_ACTIVATION_CHANGED', 'This conversation changed Team mode. Reload before sending this input.');
    if (activation && expectedStopVersion !== undefined && activation.stopVersion !== expectedStopVersion) fail('TEAM_GENERATION_EXPIRED', 'This Team input belongs to an expired run. Send it again explicitly.');
    if (activation?.status === 'stopping') fail('TEAM_STOPPING', 'The Team is still stopping. Wait for execution cleanup before continuing.');
    return activation;
  }
  /** Refresh configuration after a stopped run, without reviving its old work. */
  async refreshStoppedActivation(sessionKey: string, activationId: string, expectedStopVersion: number): Promise<TeamRuntimeActivation> {
    const current = await this.assertActivation(sessionKey, activationId, expectedStopVersion);
    if (!current) fail('TEAM_ACTIVATION_CHANGED', 'This Team activation is no longer current.');
    if (current!.status !== 'stopped' || !this.options.refreshActivation) return current!;
    const refreshed = await this.options.refreshActivation(clone(current!));
    return this.mutate(state => {
      const activation = this.activation(state, sessionKey, activationId);
      if (activation.stopVersion !== expectedStopVersion) fail('TEAM_GENERATION_EXPIRED', 'This Team input belongs to an expired run. Send it again explicitly.');
      if (activation.status !== 'stopped') fail('TEAM_ACTIVATION_CHANGED', 'The Team changed while its configuration was being refreshed. Retry this input.');
      activation.team = clone(refreshed.team); activation.participants = clone(refreshed.participants); activation.probeFingerprint = refreshed.probeFingerprint; activation.updatedAt = now();
      return clone(activation);
    });
  }

  /**
   * Resolve the latest Team only at the boundary of a new human-driven run.
   * An active activation keeps its frozen snapshot while any work, message,
   * interaction, or notification from that run remains outstanding.
   */
  async prepareHumanTurn(sessionKey: string, activationId: string, expectedStopVersion: number): Promise<{ activation: TeamRuntimeActivation; refreshed: boolean }> {
    const current = await this.assertActivation(sessionKey, activationId, expectedStopVersion);
    if (current === null) throw new TeamError('TEAM_ACTIVATION_CHANGED', 'This Team activation is no longer current.');
    if (current.status === 'stopped') {
      const refreshed = await this.refreshStoppedActivation(sessionKey, activationId, expectedStopVersion);
      return { activation: refreshed, refreshed: refreshed !== current };
    }
    if (current.status !== 'active' || !this.options.refreshActivation || !this.isWholeTeamIdle(current, sessionKey)) return { activation: current, refreshed: false };
    const latest = await this.options.refreshActivation(clone(current));
    const updated = await this.mutate(state => {
      const activation = this.activation(state, sessionKey, activationId);
      if (activation.stopVersion !== expectedStopVersion) fail('TEAM_GENERATION_EXPIRED', 'This Team input belongs to an expired run. Send it again explicitly.');
      if (activation.status !== 'active' || !this.isWholeTeamIdle(activation, sessionKey)) return clone(activation);
      activation.team = clone(latest.team); activation.participants = clone(latest.participants); activation.probeFingerprint = latest.probeFingerprint; activation.updatedAt = now();
      return clone(activation);
    });
    return { activation: updated, refreshed: updated.probeFingerprint !== current.probeFingerprint || hash(updated.team) !== hash(current.team) || hash(updated.participants) !== hash(current.participants) };
  }
  /** Called only after a human input is accepted, using the current stop generation. */
  async onHumanTurn(sessionKey: string, activationId: string, expectedStopVersion: number): Promise<void> {
    await this.mutate(state => {
      const activation = this.activation(state, sessionKey, activationId);
      if (activation.stopVersion !== expectedStopVersion) fail('TEAM_STOPPED', 'This input was stopped while being prepared. Send a new input to continue.');
      if (activation.status === 'stopping') fail('TEAM_STOPPING', 'The Team is still stopping. Wait for execution cleanup before continuing.');
      activation.runtimeOwner = { pid: process.pid, instanceId: this.instanceId };
      activation.status = 'active'; activation.automaticWakeups = 0; activation.updatedAt = now();
    });
    this.schedule(activationId);
  }
  async onLeaderIdle(sessionKey: string): Promise<void> {
    // Finishing a Leader turn only makes the activation eligible for a future
    // configuration check. The snapshot is changed by prepareHumanTurn,
    // immediately before the next human-driven run is accepted.
    await this.onExecutionReady(sessionKey);
  }
  private isWholeTeamIdle(activation: TeamRuntimeActivation, sessionKey: string): boolean {
    if (this.options.isLeaderBusy?.(sessionKey)) return false;
    if (activation.turns?.some(liveTurn)) return false;
    if (activation.messages.some(message => ['queued', 'preparing', 'sending', 'uncertain'].includes(message.status))) return false;
    if (activation.interactions.some(interaction => interaction.status === 'pending')) return false;
    if (activation.notifications.some(notification => !notification.deliveredAt && !notification.cancelledAt)) return false;
    return true;
  }
  /** Recheck pending delivery when an execution reaches its mailbox-ready boundary. */
  async onExecutionReady(sessionKey: string): Promise<void> {
    if (this.disposed) return;
    const { activation } = await this.get(sessionKey);
    if (activation && !this.disposed) {
      this.schedule(activation.id);
    }
  }

  async select(command: Extract<TeamRuntimeCommand, { action: 'runtime_select' }>): Promise<TeamRuntimeView> {
    validateRuntimeCommand(command);
    await this.ready;
    const requestHash = hash(command);
    const cached = this.receipt(await this.store.read(), `selection:${command.sessionKey}`, command.requestToken, requestHash);
    if (cached !== undefined) return this.selectionReceipt(await this.store.read(), command.sessionKey, cached);
    const probe = command.team ? await this.probe(command.team, command.projectKey, command) : undefined;
    if (probe && !probe.compatible) fail('TEAM_INCOMPATIBLE', probe.issues.map(issue => issue.message).join('\n'));
    if (probe && command.probeFingerprint && command.probeFingerprint !== probe.fingerprint) fail('TEAM_PROBE_STALE', 'Team or environment changed. Check compatibility again.');
    // Project removal uses the same outer lock; committing a frozen reference cannot race deletion.
    return this.libraryLock.locked(async () => {
      if (probe) await this.options.validateSelection?.(probe, command);
      return this.mutate(state => {
      const existing = this.receipt(state, `selection:${command.sessionKey}`, command.requestToken, requestHash);
      if (existing !== undefined) return this.selectionReceipt(state, command.sessionKey, existing);
      const currentId = state.sessions[command.sessionKey];
      const current = currentId ? state.activations[currentId] : undefined;
      if (current?.status === 'stopping' || this.options.isLeaderBusy?.(command.sessionKey) || current?.turns?.some(liveTurn) || current?.messages.some(pendingMessage)) fail('TEAM_BUSY', 'Wait for Team work to finish or stop it before changing mode.');
      if (current) { current.status = 'closed'; current.updatedAt = now(); }
      let activation: TeamRuntimeActivation | null = null;
      if (probe) {
        activation = { id: randomUUID(), sessionKey: command.sessionKey, ...(command.storageProjectKey ? { storageProjectKey: command.storageProjectKey } : {}), projectKey: probe.projectKey, team: clone(probe.team), participants: clone(probe.participants), probeFingerprint: probe.fingerprint, status: 'active', createdAt: now(), updatedAt: now(), works: [], messages: [], notifications: [], interactions: [], turns: [], dispatches: [], automaticWakeups: 0, stopVersion: 0, runtimeOwner: { pid: process.pid, instanceId: this.instanceId } };
        if (activation.participants.filter(p => p.role === 'leader').length !== 1 || activation.participants.filter(p => p.role === 'teammate').length < 1 || new Set(activation.participants.map(p => p.id)).size !== activation.participants.length) fail('TEAM_INCOMPATIBLE', 'A Team needs one Leader and distinct Teammates.');
        state.activations[activation.id] = activation;
      }
      state.sessions[command.sessionKey] = activation?.id ?? null;
      const view = { activation };
      this.saveReceipt(state, `selection:${command.sessionKey}`, command.requestToken, requestHash, view);
      return clone(view);
      });
    });
  }
  async stop(sessionKey: string, expected?: { activationId: string; stopVersion: number }): Promise<TeamRuntimeView> {
    await this.ready;
    const stopped = await this.mutate(state => {
      const id = state.sessions[sessionKey], activation = id ? state.activations[id] : null;
      if (expected && activation?.id !== expected.activationId) fail('TEAM_ACTIVATION_CHANGED', 'This Team activation is no longer current.');
      if (!activation) return null;
      const retry = expected && activation.stopFromVersion === expected.stopVersion && ['stopping', 'stopped'].includes(activation.status);
      if (expected && activation.stopVersion !== expected.stopVersion && !retry) fail('TEAM_GENERATION_EXPIRED', 'This stop request belongs to an expired Team run.');
      if (activation.status === 'stopping' || activation.status === 'stopped') return clone(activation);
      activation.stopFromVersion = activation.stopVersion;
      activation.stopVersion++; activation.status = 'stopping'; activation.stopReason = 'abort'; activation.updatedAt = now();
      activation.cleanup = { startedAt: now(), pending: ['execution cleanup'] };
      this.invalidate(activation, 'stopped');
      return clone(activation);
    });
    if (!stopped) return { activation: null };
    if (stopped.status === 'stopped') return this.get(sessionKey);
    let operation = this.stopOperations.get(stopped.id);
    if (!operation) {
      for (const [key, controller] of this.controllers) if (key.startsWith(`${stopped.id}:`)) controller.abort();
      operation = this.finishStop(stopped);
      this.stopOperations.set(stopped.id, operation);
      void operation.finally(() => { if (this.stopOperations.get(stopped.id) === operation) this.stopOperations.delete(stopped.id); }).catch(() => {});
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let completed: boolean;
    try { completed = await Promise.race([operation.then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), this.options.stopTimeoutMs ?? 30_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    if (!completed) await this.mutate(state => { const a = state.activations[stopped.id]; if (a?.status === 'stopping' && a.stopVersion === stopped.stopVersion && a.cleanup) a.cleanup.timedOut = true; });
    return this.get(sessionKey);
  }
  private invalidate(activation: TeamRuntimeActivation, status: 'stopped' | 'interrupted') {
    for (const work of activation.works) {
      if (pending(work)) { work.status = status; work.endedAt = now(); if (status === 'interrupted') work.error = 'Execution interrupted by service restart. Old work will not resume automatically.'; }
      delete work.owner;
    }
    for (const message of activation.messages) {
      if (pendingMessage(message)) { message.status = 'invalidated'; message.invalidatedAt = now(); }
      else if (message.status === 'sending') { message.status = 'uncertain'; message.error = 'Execution ended while the model request was being dispatched.'; }
      delete message.owner;
    }
    for (const turn of activation.turns ?? []) if (liveTurn(turn)) { turn.status = status; turn.stopReason = status === 'stopped' ? 'aborted_streaming' : 'service_restart'; turn.endedAt = now(); delete turn.owner; }
    for (const dispatch of activation.dispatches ?? []) if (dispatch.status === 'sending') dispatch.status = 'uncertain';
    for (const notification of activation.notifications) { if (!notification.deliveredAt) notification.cancelledAt ??= now(); delete notification.owner; }
    for (const interaction of activation.interactions ?? []) {
      if (interaction.status === 'pending') { interaction.status = status === 'interrupted' ? 'expired' : 'cancelled'; interaction.resolvedAt = now(); interaction.error = status === 'interrupted' ? 'Team execution was interrupted by service restart.' : 'Team execution was stopped.'; }
    }
  }
  private async finishStop(stopped: TeamRuntimeActivation): Promise<void> {
    const prefix = `${stopped.id}:`;
    const jobs: Array<[string, Promise<unknown>]> = [
      ...[...this.drains].filter(([key]) => key.startsWith(prefix)),
      ['leader', Promise.resolve().then(() => this.options.stopLeader?.(stopped.sessionKey))],
    ];
    // Attach rejection handlers before the journal awaits below; cleanup may
    // reject immediately, but its failure must remain visible in stopping.
    for (const [, job] of jobs) void job.catch(() => {});
    const outstanding = new Set([...jobs.map(([key]) => key), 'final resource cleanup']);
    const update = async (error?: string) => this.mutate(state => {
      const a = state.activations[stopped.id];
      if (!a || a.stopVersion !== stopped.stopVersion || a.status !== 'stopping') return;
      a.cleanup = { ...a.cleanup!, pending: [...outstanding], ...(error ? { error } : {}) };
      if (!outstanding.size && !a.cleanup.error) { a.status = 'stopped'; delete a.cleanup; }
      a.updatedAt = now();
    });
    await this.mutate(state => { const a = state.activations[stopped.id]; if (a?.cleanup && a.status === 'stopping' && a.stopVersion === stopped.stopVersion) delete a.cleanup.error; });
    await update();
    await Promise.all(jobs.map(async ([key, promise]) => {
      try { await promise; outstanding.delete(key); await update(); }
      catch (error) { await update(error instanceof Error ? error.message : String(error)); }
    }));
    try {
      await this.options.finishCleanup?.(stopped);
      outstanding.delete('final resource cleanup');
      await update();
    } catch (error) { await update(error instanceof Error ? error.message : String(error)); }
  }

  async roster(actor: TeamRuntimeActor): Promise<TeamRosterResult> {
    await this.ready;
    const { activation } = this.actor(await this.store.read(), actor, false);
    const participants: TeamRosterResult['participants'] = activation.participants.map(participant => {
      const turns = (activation.turns ?? [])
        .filter(turn => turn.participantId === participant.id)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.turnId.localeCompare(b.turnId));
      const active = turns.find(liveTurn);
      return {
        id: participant.id,
        role: participant.role,
        displayName: participant.profile.config.displayName,
        status: activation.status !== 'active' ? activation.status : active?.status ?? 'idle',
        latestTurnId: turns.at(-1)?.turnId ?? null,
      };
    });
    return { participants };
  }

  async messages(actor: TeamRuntimeActor, input: TeamMessagesInput = {}): Promise<TeamMessagesResult> {
    await this.ready;
    const { activation, participant } = this.actor(await this.store.read(), actor, false);
    if (input.messageId !== undefined && (input.cursor !== undefined || input.limit !== undefined)) fail('TEAM_INVALID_INPUT', 'messageId cannot be combined with pagination parameters.');
    if (input.messageId !== undefined) text(input.messageId, 'messageId', { max: 500 });
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TEAM_INVALID_INPUT', 'limit must be between 1 and 200.');
    const visible = activation.messages.filter(message => participant.role === 'leader' || message.senderId === participant.id || message.recipientId === participant.id);
    const sorted = visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (input.messageId !== undefined) {
      const message = sorted.find(item => item.id === input.messageId);
      if (!message) fail('TEAM_MESSAGE_NOT_FOUND', 'This message is not available.');
      return { message: this.projectMessage(activation, message!) };
    }
    const boundary = input.cursor === undefined ? undefined : this.decodeCursor(input.cursor, 'message');
    const candidates = sorted
      .filter(message => ['queued', 'preparing', 'sending', 'consumed', 'delivered'].includes(message.status))
      .filter(message => !boundary || message.createdAt < boundary.createdAt || message.createdAt === boundary.createdAt && message.id < boundary.id);
    const page = candidates.slice(0, limit);
    return { items: page.map(message => this.projectMessage(activation, message)), ...(page.length === limit && page.length < candidates.length ? { nextCursor: this.encodeCursor('message', page.at(-1)!) } : {}) };
  }

  async turns(actor: TeamRuntimeActor, input: TeamTurnsInput): Promise<TeamTurnsResult> {
    await this.ready;
    const { activation, participant } = this.actor(await this.store.read(), actor, false);
    text(input.participantId, 'participantId', { max: 500 });
    if (input.turnId !== undefined && (input.cursor !== undefined || input.limit !== undefined)) fail('TEAM_INVALID_INPUT', 'turnId cannot be combined with pagination parameters.');
    const target = activation.participants.find(item => item.id === input.participantId);
    if (!target || target.role !== 'teammate') fail('TEAM_TURN_FORBIDDEN', 'Only Teammate turns are available through team_turns.');
    if (target!.id === participant.id) fail('TEAM_TURN_FORBIDDEN', 'A participant cannot query its own turn.');
    if (input.turnId !== undefined) text(input.turnId, 'turnId', { max: 500 });
    const targetTurns = (activation.turns ?? []).filter(turn => turn.participantId === target!.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.turnId.localeCompare(a.turnId));
    if (input.turnId !== undefined) {
      const turn = targetTurns.find(item => item.turnId === input.turnId);
      if (!turn) fail('TEAM_TURN_NOT_FOUND', 'This execution turn is not available.');
      const projected = this.projectTurn(activation, turn!, true);
      const finalMessage = projected.finalMessage;
      if (liveTurn(turn!) || !finalMessage) delete projected.finalMessage;
      return { turn: projected, finalResultAvailable: !liveTurn(turn!) && !!finalMessage };
    }
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TEAM_INVALID_INPUT', 'limit must be between 1 and 200.');
    const boundary = input.cursor === undefined ? undefined : this.decodeCursor(input.cursor, 'turn');
    const candidates = targetTurns.filter(turn => !boundary || turn.startedAt < boundary.createdAt || turn.startedAt === boundary.createdAt && turn.turnId < boundary.id);
    const page = candidates.slice(0, limit);
    return { participantId: target!.id, items: page.map(turn => { const projected = this.projectTurn(activation, turn, false); delete projected.finalMessage; return projected; }), ...(page.length === limit && page.length < candidates.length ? { nextCursor: this.encodeCursor('turn', page.at(-1)!) } : {}) };
  }

  private encodeCursor(kind: 'message' | 'turn', item: TeamRuntimeMessage | TeamRuntimeTurn): string {
    const value = { kind, createdAt: 'createdAt' in item ? item.createdAt : item.startedAt, id: 'createdAt' in item ? item.id : item.turnId };
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }
  private decodeCursor(cursor: string, kind: 'message' | 'turn'): { createdAt: string; id: string } {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(text(cursor, 'cursor', { max: 500 }), 'base64url').toString('utf8')); } catch { fail('TEAM_INVALID_INPUT', 'cursor is invalid.'); }
    if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== kind || typeof (value as { createdAt?: unknown }).createdAt !== 'string' || typeof (value as { id?: unknown }).id !== 'string') fail('TEAM_INVALID_INPUT', 'cursor is invalid.');
    return value as { createdAt: string; id: string };
  }
  private projectMessage(activation: TeamRuntimeActivation, message: TeamRuntimeMessage): TeamMessageProjection {
    const projected: TeamMessageProjection = { id: message.id, senderId: message.senderId, recipientId: message.recipientId, kind: message.kind ?? 'member', status: message.status, text: message.text, createdAt: message.createdAt };
    if (message.turnId) {
      const turn = activation.turns?.find(item => item.turnId === message.turnId);
      if (turn) projected.turn = { turnId: turn.turnId, status: turn.status };
    }
    return projected;
  }
  private projectFinalMessage(message: AgentTurnResult['finalMessage']): import('./runtimeTypes.js').TeamFinalMessage | undefined {
    if (!message || message.role !== 'assistant' || message.content.some(block => block.type === 'tool_call' || block.type === 'tool_result' || block.type === 'tool_result_reference')) return undefined;
    const content = message.content.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text' && block.text.length > 0).map(block => ({ type: 'text' as const, text: block.text }));
    return content.length ? { role: 'assistant', content } : undefined;
  }
  private projectTurn(activation: TeamRuntimeActivation, turn: TeamRuntimeTurn, includeFinal: boolean): TeamTurnProjection {
    const ids = [...new Set([...(turn.triggerMessageIds ?? turn.pendingMessageIds ?? []), ...turn.messageIds])];
    const messages = ids.map(id => activation.messages.find(message => message.id === id)).filter((message): message is TeamRuntimeMessage => !!message).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(message => this.projectMessage(activation, message));
    const projected: TeamTurnProjection = { turnId: turn.turnId, status: turn.status, trigger: turn.trigger, startedAt: turn.startedAt, ...(turn.endedAt ? { endedAt: turn.endedAt } : {}), messages };
    if (includeFinal) {
      const finalMessage = this.projectFinalMessage(turn.finalMessage);
      if (finalMessage) projected.finalMessage = finalMessage;
    }
    return projected;
  }
  /** Persist a Teammate request before it is exposed to a host UI. */
  async createInteraction(input: {
    sessionKey: string; activationId: string; stopVersion: number; participantId: string;
    requestId: string; kind: TeamHumanInteractionKind; request: unknown; toolName?: string; toolCallId?: string; workId?: string; turnId?: string;
  }): Promise<TeamHumanInteraction> {
    return this.mutate(state => {
      const activation = this.activation(state, input.sessionKey, input.activationId);
      if (activation.stopVersion !== input.stopVersion) fail('TEAM_GENERATION_EXPIRED', 'This interaction belongs to an expired Team run.');
      if (activation.status !== 'active') fail('TEAM_STOPPED', 'This Team run is no longer accepting human interactions.');
      const participant = activation.participants.find(item => item.id === input.participantId && item.role === 'teammate');
      if (!participant) fail('TEAM_ACTOR_INVALID', 'This participant does not belong to the Team.');
      const teammate = participant!;
      const existing = activation.interactions.find(item => item.requestId === input.requestId && item.stopVersion === input.stopVersion);
      if (existing) {
        const existingHash = hash({ participantId: existing.participantId, kind: existing.kind, request: existing.request, toolName: existing.toolName, toolCallId: existing.toolCallId, workId: existing.workId, turnId: existing.turnId });
        const incomingHash = hash({ participantId: teammate.id, kind: input.kind, request: input.request, toolName: input.toolName, toolCallId: input.toolCallId, workId: input.workId, turnId: input.turnId });
        if (existingHash !== incomingHash) fail('TEAM_INTERACTION_CONFLICT', 'This interaction request id is already bound to different Team request data.');
        return clone(existing);
      }
      const interaction: TeamHumanInteraction = {
        id: randomUUID(), requestId: input.requestId, activationId: activation.id, sessionKey: activation.sessionKey,
        stopVersion: activation.stopVersion, participantId: teammate.id, participantDisplayName: teammate.profile.config.displayName,
        kind: input.kind, ...(input.toolName ? { toolName: input.toolName } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        request: clone(input.request), ...(input.workId ? { workId: input.workId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}), status: 'pending', createdAt: now(),
      };
      activation.interactions.push(interaction); activation.updatedAt = now();
      return clone(interaction);
    });
  }
  async respondInteraction(input: Extract<TeamRuntimeCommand, { action: 'runtime_interaction_respond' }>, deliver: (response: NormalizedTeamResponse) => boolean): Promise<TeamRuntimeInteractionResponse> {
    validateRuntimeCommand(input);
    const response = normalizeTeamInteractionResponse(input);
    return this.mutate(state => {
      const activation = this.activation(state, input.sessionKey, input.activationId);
      if (activation.stopVersion !== input.stopVersion) fail('TEAM_GENERATION_EXPIRED', 'This interaction belongs to an expired Team run.');
      const item = activation.interactions.find(candidate => candidate.id === input.interactionId && candidate.requestId === input.requestId);
      if (!item || item.participantId !== input.participantId || item.kind !== input.kind || item.stopVersion !== input.stopVersion) fail('TEAM_INTERACTION_NOT_FOUND', 'This Team interaction is no longer available.');
      const interaction = item!;
      if (interaction.status !== 'pending') return { interaction: clone(interaction), delivered: false };
      if (activation.status !== 'active') fail('TEAM_STOPPED', 'This Team run is no longer accepting responses.');
      // The callback is synchronous: owner validation, bus consumption and
      // result mutation cannot interleave with Team stop or another response.
      if (!deliver(response)) return { interaction: clone(interaction), delivered: false };
      interaction.status = response.status; interaction.resolvedAt = now(); interaction.resolution = clone(response.resolution);
      if (input.reason) interaction.error = input.reason;
      activation.updatedAt = now();
      this.interactionReceipts.set(interaction.id, clone(interaction));
      return { interaction: clone(interaction), delivered: true };
    });
  }
  /** A dead in-process waiter remains visible as historical, non-actionable data. */
  async invalidateInteraction(input: { sessionKey: string; activationId: string; participantId: string; stopVersion: number; requestId: string }, reason: string): Promise<TeamHumanInteraction | undefined> {
    return this.mutate(state => {
      const activation = state.activations[input.activationId];
      if (!activation || activation.sessionKey !== input.sessionKey) return undefined;
      const interaction = activation.interactions.find(item => item.requestId === input.requestId && item.participantId === input.participantId && item.stopVersion === input.stopVersion);
      if (!interaction) return undefined;
      if (interaction.status === 'pending') { interaction.status = 'cancelled'; interaction.resolvedAt = now(); interaction.error = reason; activation.updatedAt = now(); }
      return clone(interaction);
    });
  }
  /** Read one interaction for idempotent duplicate responses without mutating it. */
  async getInteraction(input: Extract<TeamRuntimeCommand, { action: 'runtime_interaction_respond' }>): Promise<TeamHumanInteraction | undefined> {
    validateRuntimeCommand(input);
    normalizeTeamInteractionResponse(input);
    await this.ready;
    const state = await this.store.read();
    const activation = this.activation(state, input.sessionKey, input.activationId);
    if (activation.stopVersion !== input.stopVersion) fail('TEAM_GENERATION_EXPIRED', 'This interaction belongs to an expired Team run.');
    const item = activation.interactions.find(candidate => candidate.id === input.interactionId && candidate.requestId === input.requestId);
    if (!item || item.participantId !== input.participantId || item.kind !== input.kind || item.stopVersion !== input.stopVersion) fail('TEAM_INTERACTION_NOT_FOUND', 'This Team interaction is no longer available.');
    return clone(item);
  }
  async participantMessages(input: Extract<TeamRuntimeCommand, { action: 'runtime_participant_messages' }>): Promise<TeamRuntimeParticipantMessages> {
    const activation = await this.assertActivation(input.sessionKey, input.activationId, input.stopVersion);
    if (!activation) fail('TEAM_ACTIVATION_CHANGED', 'This Team activation is no longer current.');
    const currentActivation = activation!;
    const participant = currentActivation.participants.find(item => item.id === input.participantId && item.role === 'teammate');
    if (!participant) fail('TEAM_ACTOR_INVALID', 'This participant does not belong to the Team.');
    if (this.options.readParticipantMessages) {
      return clone(await this.options.readParticipantMessages({ activation: currentActivation, participant: participant!, cursor: input.cursor, limit: input.limit }));
    }
    const limit = input.limit ?? 100;
    const offset = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
    const visible = currentActivation.messages.filter(item => item.senderId === input.participantId || item.recipientId === input.participantId);
    const messages = visible.slice(offset, offset + limit).map(item => ({ id: item.id, role: item.senderId === input.participantId ? 'assistant' : 'user', text: item.text, createdAt: item.createdAt, type: 'team_message' }));
    return { sessionKey: input.sessionKey, activationId: input.activationId, participantId: input.participantId, messages, ...(offset + messages.length < visible.length ? { nextCursor: String(offset + messages.length) } : {}) };
  }
  async send(actor: TeamRuntimeActor, input: { recipientId: string; text: string; requestToken: string }): Promise<TeamRuntimeMessage> {
    text(input.requestToken, 'requestToken', { max: 500 });
    text(input.text, 'text');
    const result = await this.mutate(state => {
      const { activation, participant } = this.actor(state, actor);
      const recipient = activation.participants.find(p => p.id === input.recipientId);
      if (!recipient || recipient.id === participant.id) fail('TEAM_RECIPIENT_INVALID', 'Choose another participant from this activation.');
      const requestHash = hash(input), scope = `message:${activation.id}:${participant.id}`;
      const existing = this.receipt(state, scope, input.requestToken, requestHash);
      if (existing !== undefined) {
        if ((existing as TeamRuntimeMessage).stopVersion !== activation.stopVersion) fail('TEAM_GENERATION_EXPIRED', 'This message token belongs to an expired Team run. Send a new message explicitly.');
        return clone(existing as TeamRuntimeMessage);
      }
      const message: TeamRuntimeMessage = { id: randomUUID(), stopVersion: activation.stopVersion, kind: 'member', senderId: participant.id, recipientId: recipient!.id, intendedRecipientId: recipient!.id, text: input.text, createdAt: now(), status: 'queued' };
      activation.messages.push(message); activation.updatedAt = now();
      for (const pending of activation.messages) if (pending.recipientId === recipient!.id && pendingMessage(pending)) delete pending.error;
      this.saveReceipt(state, scope, input.requestToken, requestHash, message);
      return clone(message);
    });
    this.schedule(actor.activationId);
    return result;
  }

  async pendingMessages(actor: TeamRuntimeActor, turnId?: string): Promise<TeamRuntimeMessage[]> {
    await this.ready;
    if (turnId) return this.mutate(state => {
      const { activation } = this.actor(state, actor);
      const pending = activation.messages.filter(message => message.recipientId === actor.participantId && message.stopVersion === actor.stopVersion && pendingMessage(message));
      const turn = activation.turns?.find(turn => turn.turnId === turnId && turn.participantId === actor.participantId && liveTurn(turn));
      if (!turn) fail('TEAM_TURN_NOT_RUNNING', 'This execution is no longer active.');
      turn!.pendingMessageIds = pending.map(message => message.id);
      return clone(pending);
    });
    const { activation } = this.actor(await this.store.read(), actor);
    return clone(activation.messages.filter(message => message.recipientId === actor.participantId && message.stopVersion === actor.stopVersion && pendingMessage(message)));
  }

  async deleteMessage(input: Extract<TeamRuntimeCommand, { action: 'runtime_message_delete' }>): Promise<TeamMessageDeleteResult> {
    validateRuntimeCommand(input);
    let queueChanged = false;
    const result = await this.mutate(state => {
      const activation = this.activation(state, input.sessionKey, input.activationId);
      const message = activation.messages.find(item => item.id === input.messageId && item.recipientId === input.participantId && item.stopVersion === input.stopVersion);
      if (!message) fail('TEAM_MESSAGE_NOT_FOUND', 'This message is not available.');
      if (message!.kind && message!.kind !== 'member') fail('TEAM_SYSTEM_MESSAGE', 'System notifications cannot be deleted.');
      if (message!.status === 'deleted') return { messageId: message!.id, deleted: true };
      if (['sending', 'uncertain', 'legacy_unknown', 'delivered'].includes(message!.status)) fail('TEAM_MESSAGE_SEND_UNCERTAIN', 'This message may already have been sent; its sending status is uncertain and it cannot be deleted.');
      if (message!.status === 'consumed') fail('TEAM_MESSAGE_ALREADY_SENT', 'This message has already been sent to a model request and cannot be deleted.');
      const notify = activation.status === 'active' && message!.stopVersion === activation.stopVersion && pendingMessage(message!);
      message!.status = 'deleted'; message!.deletedAt = now(); delete message!.owner;
      if (notify) {
        queueChanged = true;
        for (const queued of activation.messages) if (queued.recipientId === input.participantId && pendingMessage(queued)) delete queued.error;
      }
      if (notify && activation.participants.some(p => p.id === message!.senderId)) {
        const name = activation.participants.find(p => p.id === message!.recipientId)?.profile.config.displayName ?? message!.recipientId;
        this.systemMessage(activation, message!.senderId, 'message_deleted', `用户删除了你发给「${name}」的消息，对方没有收到。请更换思路，或尽快结束当前执行并给出最终回复。`, { sourceMessageId: message!.id });
      }
      activation.updatedAt = now();
      return { messageId: message!.id, deleted: true };
    });
    if (queueChanged) this.schedule(input.activationId);
    return result;
  }

  async beginTurn(actor: TeamRuntimeActor, input: { turnId: string; trigger: 'human' | 'messages' }): Promise<TeamRuntimeTurn> {
    text(input.turnId, 'turnId', { max: 500 });
    while (true) {
      const claimed = await this.mutate(state => {
        const { activation } = this.actor(state, actor);
        const existing = activation.turns?.find(turn => turn.turnId === input.turnId && turn.participantId === actor.participantId);
        if (existing) return { turn: clone(existing) };
        const live = activation.turns?.find(turn => turn.participantId === actor.participantId && liveTurn(turn));
        if (live) {
          const key = `${actor.activationId}:${actor.participantId}:${actor.stopVersion}`;
          if (input.trigger === 'human' && live.trigger === 'messages' && live.status === 'preparing' && this.drains.has(key)) return { wait: key };
          fail('TEAM_PARTICIPANT_BUSY', 'This participant already has an active execution.');
        }
        const turn: TeamRuntimeTurn = { turnId: input.turnId, participantId: actor.participantId, stopVersion: actor.stopVersion, trigger: input.trigger, status: 'preparing', startedAt: now(), messageIds: [], requestIds: [], triggerMessageIds: [], owner: { pid: process.pid, instanceId: this.instanceId, executionId: input.turnId } };
        (activation.turns ??= []).push(turn); activation.updatedAt = now();
        return { turn: clone(turn) };
      });
      if (claimed.turn) return claimed.turn;
      // The router has already accepted this human input. Let the auto-start
      // attempt observe that busy router and release its preparation claim.
      await this.drains.get(claimed.wait!);
    }
  }

  async endTurn(actor: TeamRuntimeActor, turnId: string, result?: AgentTurnResult, error?: string, options: { retry?: boolean } = {}): Promise<void> {
    await this.mutate(state => {
      const activation = state.activations[actor.activationId];
      const turn = activation?.turns?.find(item => item.turnId === turnId && item.participantId === actor.participantId && item.stopVersion === actor.stopVersion);
      if (!activation || !turn || !liveTurn(turn)) return;
      const active = activation.status === 'active' && activation.stopVersion === actor.stopVersion;
      turn.status = active ? 'ended' : 'stopped'; turn.endedAt = result?.completedAt ?? now(); delete turn.owner;
      turn.resultType = result?.type ?? (error ? 'error' : 'success'); turn.stopReason = result?.stopReason ?? (error ? 'model_error' : options.retry ? 'execution_busy' : 'completed');
      if (result?.finalMessage) turn.finalMessage = clone(result.finalMessage);
      if (error || result?.errors?.length) turn.error = error ?? result!.errors!.map(item => item.message).join('\n');
      if (turn.error && !options.retry) {
        const pending = activation.messages.filter(message => message.stopVersion === actor.stopVersion && message.recipientId === actor.participantId && pendingMessage(message));
        if (hash(pending.map(message => message.id)) === hash(turn.pendingMessageIds ?? [])) for (const message of pending) message.error = turn.error;
      }
      const participant = activation.participants.find(item => item.id === actor.participantId);
      const emptyCancelled = !turn.requestIds.length && !turn.error && (!result || result.type === 'success');
      if (active && !options.retry && !emptyCancelled && participant?.role === 'teammate') {
        const leader = activation.participants.find(item => item.role === 'leader')!;
        this.systemMessage(activation, leader.id, 'turn_ended', `${participant.profile.config.displayName} 的执行轮次 ${turnId} 已结束，原因：${turn.stopReason}。请调用 team_turns，并指定 participantId=${participant.id}、turnId=${turnId} 查看该 turn 的消息和最终回复。`, { sourceTurnId: turnId });
      }
      activation.updatedAt = now();
    });
    this.schedule(actor.activationId);
  }

  async updateTurnStatus(actor: TeamRuntimeActor, turnId: string, status: 'running' | 'waiting_approval'): Promise<void> {
    await this.mutate(state => {
      const { activation } = this.actor(state, actor);
      const turn = activation.turns?.find(item => item.turnId === turnId && item.participantId === actor.participantId && liveTurn(item));
      if (turn) turn.status = status;
    });
  }

  async dispatchMessages<T>(actor: TeamRuntimeActor, input: { turnId: string; requestId: string; attemptId?: string; messageIds: string[]; hasHumanInput?: boolean }, start: (messages: TeamRuntimeMessage[]) => T): Promise<{ value: T; messages: TeamRuntimeMessage[]; attemptId: string }> {
    let value!: T;
    const attemptId = input.attemptId ?? randomUUID();
    const messages = await this.mutate(async state => {
      const { activation } = this.actor(state, actor);
      const attempts = activation.dispatches?.filter(dispatch => dispatch.requestId === input.requestId && dispatch.participantId === actor.participantId) ?? [];
      const existing = attempts.find(dispatch => dispatch.status === 'consumed') ?? attempts.at(-1);
      if (existing && (existing.turnId !== input.turnId || existing.stopVersion !== actor.stopVersion)) fail('TEAM_REQUEST_CONFLICT', 'This request identity is already bound to another execution.');
      if (attempts.some(dispatch => dispatch.status !== 'consumed')) fail('TEAM_REQUEST_UNCERTAIN', 'This request may already have been sent and cannot be replayed automatically.');
      if (activation.dispatches?.some(dispatch => dispatch.attemptId === attemptId)) fail('TEAM_ATTEMPT_DUPLICATE', 'An actual send attempt cannot be invoked twice.');
      const batchIds = existing?.messageIds ?? input.messageIds;
      const accepted = activation.messages.filter(message => message.recipientId === actor.participantId && message.stopVersion === actor.stopVersion && batchIds.includes(message.id) && (existing ? message.status === 'consumed' : pendingMessage(message)));
      const turn = activation.turns?.find(item => item.turnId === input.turnId && item.participantId === actor.participantId);
      if (!turn || !liveTurn(turn)) fail('TEAM_TURN_NOT_RUNNING', 'This execution is no longer active.');
      if (!accepted.length && turn!.trigger === 'messages' && !turn!.requestIds.length && !input.hasHumanInput) fail('TEAM_EMPTY_BATCH', 'The pending messages were removed before this execution could start.');
      turn!.pendingMessageIds = accepted.filter(pendingMessage).map(message => message.id);
      (turn!.triggerMessageIds ??= []);
      for (const message of accepted) if (!turn!.triggerMessageIds.includes(message.id)) turn!.triggerMessageIds.push(message.id);
      const dispatch = { requestId: input.requestId, attemptId, participantId: actor.participantId, turnId: input.turnId, stopVersion: actor.stopVersion, messageIds: accepted.map(message => message.id), status: 'sending' as const, startedAt: now() };
      (activation.dispatches ??= []).push(dispatch);
      const originalStatuses = new Map(accepted.map(message => [message.id, message.status]));
      for (const message of accepted) if (pendingMessage(message)) message.status = 'sending';
      await this.store.write(state);
      try {
        if (this.disposed) throw Object.assign(new TeamError('TEAM_RUNTIME_CLOSED', 'Team execution is shutting down.'), { requestDispatched: false });
        value = start(clone(accepted)); void Promise.resolve(value).catch(() => {});
      }
      catch (caught) {
        if ((caught as { requestDispatched?: boolean }).requestDispatched === false || ['TEAM_EMPTY_BATCH', 'TEAM_MESSAGE_BATCH_TOO_LARGE'].includes((caught as { code?: string }).code ?? '')) {
          for (const message of accepted) if (message.status === 'sending') message.status = originalStatuses.get(message.id)!;
          activation.dispatches = activation.dispatches!.filter(item => item !== dispatch);
          await this.store.write(state);
          throw caught;
        }
        for (const message of accepted) if (message.status === 'sending') { message.status = 'uncertain'; message.error = caught instanceof Error ? caught.message : String(caught); }
        Object.assign(dispatch, { status: 'uncertain', error: caught instanceof Error ? caught.message : String(caught) });
        await this.store.write(state);
        throw caught;
      }
      const dispatchedAt = now();
      Object.assign(dispatch, { status: 'consumed', dispatchedAt });
      turn!.status = 'running';
      if (!turn!.requestIds.includes(input.requestId)) turn!.requestIds.push(input.requestId);
      (turn!.attemptIds ??= []).push(attemptId);
      for (const message of accepted) {
        message.status = 'consumed'; message.consumedAt ??= dispatchedAt; message.deliveredAt ??= dispatchedAt; message.requestId ??= input.requestId; message.attemptId ??= attemptId; message.turnId ??= input.turnId; delete message.error;
        if (!turn!.messageIds.includes(message.id)) turn!.messageIds.push(message.id);
      }
      activation.updatedAt = dispatchedAt;
      return clone(accepted);
    });
    return { value, messages, attemptId };
  }

  private systemMessage(activation: TeamRuntimeActivation, recipientId: string, kind: 'turn_ended' | 'message_deleted', messageText: string, source: { sourceTurnId?: string; sourceMessageId?: string }): void {
    if (activation.messages.some(message => message.kind === kind && message.stopVersion === activation.stopVersion && message.sourceTurnId === source.sourceTurnId && message.sourceMessageId === source.sourceMessageId)) return;
    activation.messages.push({ id: randomUUID(), stopVersion: activation.stopVersion, senderId: 'system', recipientId, intendedRecipientId: recipientId, kind, text: messageText, status: 'queued', createdAt: now(), ...source });
  }

  private actor(state: RuntimeState, actor: TeamRuntimeActor, requireActive = true) {
    const activation = this.activation(state, actor.sessionKey, actor.activationId);
    if (actor.stopVersion !== activation.stopVersion) fail('TEAM_GENERATION_EXPIRED', 'This participant belongs to an expired Team run.');
    if (requireActive && activation.status !== 'active') fail('TEAM_STOPPED', 'This Team is stopped. A new human input is required to continue.');
    const participant = activation.participants.find(p => p.id === actor.participantId);
    if (!participant) fail('TEAM_ACTOR_INVALID', 'This participant does not belong to the Team.');
    return { activation, participant: participant! };
  }
  private activation(state: RuntimeState, sessionKey: string, activationId: string): TeamRuntimeActivation {
    const activation = state.activations[activationId];
    if (!activation || activation.sessionKey !== sessionKey || state.sessions[sessionKey] !== activationId || activation.status === 'closed') fail('TEAM_ACTIVATION_CHANGED', 'This Team activation is no longer current.');
    return activation;
  }
  private selectionReceipt(state: RuntimeState, sessionKey: string, receipt: unknown): TeamRuntimeView {
    const view = receipt as TeamRuntimeView;
    const currentId = state.sessions[sessionKey];
    const current = currentId ? state.activations[currentId] : null;
    if ((view.activation?.id ?? null) !== (current?.id ?? null) || (view.activation && view.activation.stopVersion !== current?.stopVersion)) fail('TEAM_GENERATION_EXPIRED', 'This selection receipt belongs to an expired Team run. Start a new selection explicitly.');
    return clone(view);
  }
  private receipt(state: RuntimeState, scope: string, token: string, requestHash: string): unknown {
    const receipt = state.receipts[scope]?.find(item => item.token === token);
    if (receipt && receipt.hash !== requestHash) fail('TEAM_TOKEN_CONFLICT', 'This request token was already used with different parameters.');
    return receipt?.result;
  }
  private saveReceipt(state: RuntimeState, scope: string, token: string, requestHash: string, result: unknown) {
    (state.receipts[scope] ??= []).push({ token, hash: requestHash, result: clone(result) });
  }
  private async mutate<T>(body: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    await this.ready;
    if (this.disposed) throw new TeamError('TEAM_RUNTIME_CLOSED', 'Team execution is shutting down.');
    const operation = this.store.locked(async () => {
      if (this.disposed) throw new TeamError('TEAM_RUNTIME_CLOSED', 'Team execution is shutting down.');
      const state = await this.store.read(), before = hash(state);
      // Retry only the durable result write after a consumed bus response.
      // Never call the tool/elicitation waiter again.
      for (const receipt of this.interactionReceipts.values()) {
        const item = state.activations[receipt.activationId]?.interactions.find(value => value.id === receipt.id);
        if (item?.status === 'pending') Object.assign(item, clone(receipt));
      }
      const result = await body(state);
      if (before !== hash(state)) await this.store.write(state);
      for (const [id, receipt] of this.interactionReceipts) {
        if (state.activations[receipt.activationId]?.interactions.some(item => item.id === id && item.status !== 'pending')) this.interactionReceipts.delete(id);
      }
      return result;
    });
    this.storageOperations.add(operation);
    try { return await operation; } finally { this.storageOperations.delete(operation); }
  }
  private ownerAlive(owner: { pid: number; instanceId: string } | undefined): boolean {
    if (!owner) return false;
    if (owner.pid === process.pid) return liveInstances.has(owner.instanceId);
    try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private async recover(): Promise<void> {
    await this.store.locked(async () => {
      const state = await this.store.read();
      let changed = state.version !== 3;
      for (const activation of Object.values(state.activations)) {
        activation.stopVersion ??= 0;
        activation.interactions ??= [];
        activation.turns ??= [];
        activation.dispatches ??= [];
        if (state.version !== 3) {
          if (this.options.readLegacyTurns) {
            const restored = await this.options.readLegacyTurns(clone(activation));
            for (const turn of restored) if (!activation.turns.some(existing => existing.participantId === turn.participantId && existing.turnId === turn.turnId)) activation.turns.push(clone(turn));
          }
          for (const message of activation.messages) {
            message.kind ??= 'member';
            if (message.status === 'delivered') message.status = 'legacy_unknown';
            else if (pendingMessage(message) || message.status === 'stopped' || message.status === 'interrupted') { message.status = 'invalidated'; message.invalidatedAt ??= now(); }
          }
          for (const work of activation.works) if (pending(work)) { work.status = 'interrupted'; work.error = 'Legacy task execution is no longer resumed.'; work.endedAt = now(); delete work.owner; }
          for (const notification of activation.notifications) notification.cancelledAt ??= now();
        }
        for (const item of [...activation.works, ...activation.messages, ...activation.notifications]) {
          if (item.stopVersion === undefined) { item.stopVersion = activation.stopVersion; changed = true; }
        }
        if (this.ownerAlive(activation.runtimeOwner)) continue;
        for (const item of [...activation.works, ...activation.messages, ...activation.notifications]) if (item.owner) { delete item.owner; changed = true; }
        if (activation.status === 'active' || activation.status === 'stopping' || activation.turns.some(liveTurn) || activation.messages.some(pendingMessage) || activation.messages.some(message => message.status === 'sending')) {
          activation.stopFromVersion = activation.stopVersion;
          activation.stopVersion++; activation.status = activation.status === 'closed' ? 'closed' : 'stopped'; activation.stopReason = 'restart'; activation.updatedAt = now();
          this.invalidate(activation, 'interrupted'); delete activation.cleanup; delete activation.runtimeOwner; changed = true;
        }
      }
      state.version = 3;
      if (changed && !this.disposed) await this.store.write(state);
    });
  }
  private schedule(activationId: string): void {
    if (this.disposed) return;
    void this.ready.then(async () => {
      const activation = (await this.store.read()).activations[activationId];
      if (this.disposed || !activation || activation.status !== 'active') return;
      for (const participant of activation.participants) {
        const key = `${activationId}:${participant.id}:${activation.stopVersion}`;
        const queued = activation.messages.filter(message => message.stopVersion === activation.stopVersion && message.recipientId === participant.id && pendingMessage(message));
        if (!queued.length || queued.every(message => !!message.error) || this.drains.has(key) || activation.turns?.some(turn => turn.participantId === participant.id && liveTurn(turn))) continue;
        if (participant.role === 'leader' && this.options.isLeaderBusy?.(activation.sessionKey)) continue;
        const operation = this.drain(activationId, participant.id, activation.stopVersion).catch(() => {}).finally(() => {
          if (this.drains.get(key) === operation) this.drains.delete(key);
          this.schedule(activationId);
        });
        this.drains.set(key, operation);
      }
    }).catch(() => {});
  }

  private async drain(activationId: string, participantId: string, stopVersion: number): Promise<void> {
    const claim = await this.mutate(state => {
      const activation = state.activations[activationId];
      if (!activation || activation.status !== 'active' || activation.stopVersion !== stopVersion || state.sessions[activation.sessionKey] !== activationId) return null;
      const participant = activation.participants.find(item => item.id === participantId);
      if (!participant || activation.turns?.some(turn => turn.participantId === participantId && liveTurn(turn)) || participant.role === 'leader' && this.options.isLeaderBusy?.(activation.sessionKey)) return null;
      const messages = activation.messages.filter(message => message.stopVersion === stopVersion && message.recipientId === participantId && pendingMessage(message));
      if (!messages.length || messages.every(message => !!message.error)) return null;
      const turnId = randomUUID();
      const owner = { pid: process.pid, instanceId: this.instanceId, executionId: turnId };
      for (const message of messages) { message.status = 'preparing'; message.owner = owner; }
      (activation.turns ??= []).push({ turnId, participantId, stopVersion, trigger: 'messages', status: 'preparing', startedAt: now(), messageIds: [], requestIds: [], pendingMessageIds: messages.map(message => message.id), triggerMessageIds: messages.map(message => message.id), owner });
      const isolated = clone(activation);
      if (participant.role !== 'leader') {
        isolated.works = isolated.works.filter(work => work.participantId === participantId);
        isolated.messages = isolated.messages.filter(message => message.senderId === participantId || message.recipientId === participantId);
        isolated.turns = isolated.turns?.filter(turn => turn.participantId === participantId);
        isolated.dispatches = isolated.dispatches?.filter(dispatch => dispatch.participantId === participantId);
        isolated.notifications = []; isolated.interactions = [];
      }
      return { activation: isolated, participant: clone(participant), messages: clone(messages), executionId: turnId, turnId, trigger: 'messages' as const, messageOnly: true as const };
    });
    if (!claim) return;
    const key = `${activationId}:${participantId}:${stopVersion}:execution`;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const actor = { sessionKey: claim.activation.sessionKey, activationId, participantId, stopVersion };
    let output: Awaited<ReturnType<TeamRuntimeOptions['executeParticipant']>> | undefined, error: unknown;
    try {
      const latest = (await this.store.read()).activations[activationId];
      if (this.disposed || latest?.status !== 'active' || latest.stopVersion !== stopVersion) controller.abort();
      if (controller.signal.aborted) throw new Error('Team execution stopped before starting.');
      output = await this.options.executeParticipant({ ...claim, signal: controller.signal, updateStatus: status => this.updateTurnStatus(actor, claim.turnId, status) });
    } catch (caught) { error = caught; }
    finally { if (this.controllers.get(key) === controller) this.controllers.delete(key); }
    if (this.disposed) return;
    const errorText = error instanceof Error ? error.message : error ? String(error) : undefined;
    await this.endTurn(actor, claim.turnId, output?.result, errorText, { retry: output?.retry });
    await this.mutate(state => {
      const activation = state.activations[activationId];
      if (!activation) return;
      for (const message of activation.messages) {
        if (message.owner?.executionId !== claim.executionId) continue;
        delete message.owner;
        if (message.status === 'preparing') {
          message.status = activation.status === 'active' && activation.stopVersion === stopVersion ? 'queued' : 'invalidated';
        }
      }
    });
    if (!error) await this.onExecutionReady(claim.activation.sessionKey);
  }
  /** Shutdown does not claim completion or replay a partially executed task. */
  async dispose(): Promise<void> {
    this.disposed = true; liveInstances.delete(this.instanceId);
    for (const controller of this.controllers.values()) controller.abort();
    await this.ready.catch(() => {});
    // Model/tool shutdown may take time. Only wait for already-started storage
    // writes; their uncertain executions are recovered as interrupted later.
    await Promise.allSettled([...this.storageOperations]);
  }
}
