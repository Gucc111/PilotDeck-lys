import { randomUUID } from 'node:crypto';
import { TeamStore, hash } from './store.js';
import { TeamError, object, text } from './validation.js';
import { TeamRuntimeStore, type RuntimeState } from './runtimeStore.js';
import type { ProfileRef } from './types.js';
import type { TeamRuntimeActivation, TeamRuntimeCommand, TeamRuntimeCommandResult, TeamRuntimeMessage, TeamRuntimeNotification, TeamRuntimeOptions, TeamRuntimeProbe, TeamRuntimeView, TeamRuntimeWork } from './runtimeTypes.js';

export type TeamRuntimeActor = { sessionKey: string; activationId: string; participantId: string };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const liveInstances = new Set<string>();
const pending = (work: TeamRuntimeWork) => ['queued', 'running', 'waiting_information', 'waiting_approval'].includes(work.status);
const running = (work: TeamRuntimeWork) => ['running', 'waiting_approval', 'waiting_information'].includes(work.status) && !!work.owner;
const fail = (code: string, message: string): never => { throw new TeamError(code, message); };

function ref(value: unknown): ProfileRef {
  const item = object(value, 'team', ['id', 'revision']);
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1) fail('TEAM_INVALID_INPUT', 'team.revision must be a positive integer.');
  return { id: text(item.id, 'team.id', { max: 200 }), revision: Number(item.revision) };
}
export function validateRuntimeCommand(input: TeamRuntimeCommand): TeamRuntimeCommand {
  const action = (input as { action?: unknown })?.action;
  const allowed = action === 'runtime_probe' ? ['action', 'team', 'sessionKey', 'storageProjectKey', 'projectKey']
    : action === 'runtime_select' ? ['action', 'team', 'sessionKey', 'storageProjectKey', 'projectKey', 'requestToken', 'probeFingerprint']
      : action === 'runtime_get' || action === 'runtime_stop' ? ['action', 'sessionKey'] : [];
  if (!allowed.length) fail('TEAM_INVALID_INPUT', 'Unknown Team runtime command.');
  const data = object(input, 'command', allowed);
  for (const key of ['sessionKey', 'storageProjectKey', 'projectKey', 'requestToken', 'probeFingerprint']) if (data[key] !== undefined) text(data[key], key, { max: 500 });
  if (action !== 'runtime_probe' || data.sessionKey !== undefined) text(data.sessionKey, 'sessionKey', { max: 500 });
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
  private readonly flushes = new Map<string, Promise<void>>();
  private readonly flushRequested = new Set<string>();
  private readonly storageOperations = new Set<Promise<unknown>>();
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
      case 'runtime_get': return this.get(command.sessionKey);
      case 'runtime_stop': return this.stop(command.sessionKey);
    }
  }
  async probe(teamRef: ProfileRef, projectKey?: string, context?: { sessionKey?: string; storageProjectKey?: string }): Promise<TeamRuntimeProbe> {
    ref(teamRef);
    if (projectKey !== undefined) text(projectKey, 'projectKey', { max: 500 });
    const team = await this.options.resolveTeam(teamRef);
    if (team.archived) fail('TEAM_ARCHIVED', 'Restore this Team before selecting it.');
    const result = await this.options.probe(clone(team), projectKey, context);
    return { team, projectKey: result.projectKey, participants: result.participants, issues: result.issues, compatible: !result.issues.some(issue => issue.severity === 'error'), fingerprint: hash({ team, ...result, storageProjectKey: context?.storageProjectKey }) };
  }
  async get(sessionKey: string): Promise<TeamRuntimeView> {
    await this.ready;
    const state = await this.store.read();
    const activation = state.sessions[sessionKey] ? state.activations[state.sessions[sessionKey]!] : null;
    const history = Object.values(state.activations).filter(a => a.sessionKey === sessionKey && a.id !== activation?.id).reverse();
    const budgetPaused = activation?.status === 'active' && activation.automaticWakeups >= (this.options.maxAutomaticWakeups ?? 24) && activation.notifications.some(n => !n.deliveredAt && !n.cancelledAt);
    return { activation: clone(activation ?? null), ...(history.length ? { history: clone(history) } : {}), ...(budgetPaused ? { continuationPaused: 'budget' as const } : {}) };
  }
  async projectReferences(projectKey: string): Promise<boolean> {
    await this.ready;
    const state = await this.store.read();
    return Object.values(state.activations).some(a => a.projectKey === projectKey || a.storageProjectKey === projectKey || a.participants.some(p => p.projectKey === projectKey));
  }
  async assertActivation(sessionKey: string, activationId: string | null | undefined): Promise<TeamRuntimeActivation | null> {
    const { activation } = await this.get(sessionKey);
    if (activationId !== undefined && (activation?.id ?? null) !== activationId) fail('TEAM_ACTIVATION_CHANGED', 'This conversation changed Team mode. Reload before sending this input.');
    return activation;
  }
  /** Called only after a human input is accepted. A fresh human request renews the continuation budget. */
  async onHumanTurn(sessionKey: string, activationId: string, expectedStopVersion?: number): Promise<void> {
    await this.mutate(state => {
      const activation = this.activation(state, sessionKey, activationId);
      if (expectedStopVersion !== undefined && (activation.stopVersion ?? 0) !== expectedStopVersion) fail('TEAM_STOPPED', 'This input was stopped while being prepared. Send a new input to continue.');
      activation.status = 'active'; activation.automaticWakeups = 0; activation.updatedAt = now();
    });
    this.schedule(activationId);
  }
  async onLeaderIdle(sessionKey: string): Promise<void> {
    if (this.disposed) return;
    const { activation } = await this.get(sessionKey);
    if (activation && !this.disposed) {
      this.schedule(activation.id);
      if (activation.notifications.some(n => !n.deliveredAt && !n.cancelledAt)) await this.flush(activation.id);
    }
  }

  async select(command: Extract<TeamRuntimeCommand, { action: 'runtime_select' }>): Promise<TeamRuntimeView> {
    validateRuntimeCommand(command);
    await this.ready;
    const requestHash = hash(command);
    const cached = this.receipt(await this.store.read(), `selection:${command.sessionKey}`, command.requestToken, requestHash);
    if (cached !== undefined) return clone(cached as TeamRuntimeView);
    const probe = command.team ? await this.probe(command.team, command.projectKey, command) : undefined;
    if (probe && !probe.compatible) fail('TEAM_INCOMPATIBLE', probe.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('\n'));
    if (probe && command.probeFingerprint && command.probeFingerprint !== probe.fingerprint) fail('TEAM_PROBE_STALE', 'Team or environment changed. Check compatibility again.');
    if (probe?.issues.some(issue => issue.severity === 'warning') && command.probeFingerprint !== probe.fingerprint) fail('TEAM_CONFIRMATION_REQUIRED', 'Review and confirm the compatibility warnings before selecting this Team.');
    // Project removal uses the same outer lock; committing a frozen reference cannot race deletion.
    return this.libraryLock.locked(async () => {
      if (probe) await this.options.validateSelection?.(probe, command);
      return this.mutate(state => {
      const existing = this.receipt(state, `selection:${command.sessionKey}`, command.requestToken, requestHash);
      if (existing !== undefined) return clone(existing as TeamRuntimeView);
      const currentId = state.sessions[command.sessionKey];
      const current = currentId ? state.activations[currentId] : undefined;
      if (this.options.isLeaderBusy?.(command.sessionKey) || current?.works.some(pending) || current?.messages.some(m => m.status === 'queued') || current?.notifications.some(n => !n.deliveredAt && !n.cancelledAt)) fail('TEAM_BUSY', 'Wait for Team work to finish or stop it before changing mode.');
      if (current) { current.status = 'closed'; current.updatedAt = now(); }
      let activation: TeamRuntimeActivation | null = null;
      if (probe) {
        activation = { id: randomUUID(), sessionKey: command.sessionKey, ...(command.storageProjectKey ? { storageProjectKey: command.storageProjectKey } : {}), projectKey: probe.projectKey, team: clone(probe.team), participants: clone(probe.participants), probeFingerprint: probe.fingerprint, status: 'active', createdAt: now(), updatedAt: now(), works: [], messages: [], notifications: [], automaticWakeups: 0, stopVersion: 0 };
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
  async stop(sessionKey: string): Promise<TeamRuntimeView> {
    await this.ready;
    const view = await this.mutate(state => {
      const id = state.sessions[sessionKey], activation = id ? state.activations[id] : null;
      if (!activation) return { activation: null };
      activation.status = 'stopped'; activation.updatedAt = now();
      activation.stopVersion = (activation.stopVersion ?? 0) + 1;
      for (const work of activation.works) if (pending(work)) { work.status = 'stopped'; work.endedAt = now(); delete work.owner; }
      for (const message of activation.messages) if (message.status === 'queued') { message.status = 'stopped'; delete message.owner; }
      for (const notification of activation.notifications) if (!notification.deliveredAt) { notification.cancelledAt = now(); delete notification.owner; }
      return { activation: clone(activation) };
    });
    if (view.activation) for (const [key, controller] of this.controllers) if (key.startsWith(`${view.activation.id}:`)) controller.abort();
    await this.options.stopLeader?.(sessionKey);
    return view;
  }

  async inspect(actor: TeamRuntimeActor): Promise<{ participants: Array<{ id: string; role: 'leader' | 'teammate'; displayName: string; description: string }>; works: TeamRuntimeWork[]; messages: TeamRuntimeMessage[] }> {
    await this.ready;
    const state = await this.store.read(), { activation, participant } = this.actor(state, actor, false);
    return clone({ participants: activation.participants.map(p => ({ id: p.id, role: p.role, displayName: p.profile.config.displayName, description: p.profile.config.description })), works: participant.role === 'leader' ? activation.works : activation.works.filter(w => w.participantId === participant.id), messages: activation.messages.filter(m => participant.role === 'leader' || m.senderId === participant.id || m.recipientId === participant.id) });
  }
  async delegate(actor: TeamRuntimeActor, input: { participantId: string; task: string; context?: string; followupOf?: string; requestToken: string }): Promise<TeamRuntimeWork> {
    text(input.task, 'task'); text(input.requestToken, 'requestToken', { max: 500 });
    if (input.context !== undefined) text(input.context, 'context', { empty: true });
    const result = await this.mutate(state => {
      const { activation, participant } = this.actor(state, actor);
      if (participant.role !== 'leader') fail('TEAM_LEADER_REQUIRED', 'Only the Leader can delegate work.');
      const target = activation.participants.find(p => p.id === input.participantId && p.role === 'teammate');
      if (!target) fail('TEAM_RECIPIENT_INVALID', 'Choose a Teammate from this activation.');
      if (input.followupOf && !activation.works.some(w => w.id === input.followupOf && w.participantId === input.participantId)) fail('TEAM_WORK_NOT_FOUND', 'The previous work does not belong to this Teammate.');
      const requestHash = hash(input), scope = `delegate:${activation.id}:${participant.id}`;
      const existing = this.receipt(state, scope, input.requestToken, requestHash);
      if (existing !== undefined) return clone(existing as TeamRuntimeWork);
      const work: TeamRuntimeWork = { id: randomUUID(), participantId: input.participantId, task: input.task, ...(input.context ? { context: input.context } : {}), ...(input.followupOf ? { followupOf: input.followupOf } : {}), status: 'queued', createdAt: now() };
      activation.works.push(work); activation.updatedAt = now();
      this.saveReceipt(state, scope, input.requestToken, requestHash, work);
      return clone(work);
    });
    this.schedule(actor.activationId);
    return result;
  }
  async collect(actor: TeamRuntimeActor, workId: string): Promise<TeamRuntimeWork> {
    await this.ready;
    const { activation, participant } = this.actor(await this.store.read(), actor, false);
    const work = activation.works.find(w => w.id === workId);
    if (!work || (participant.role !== 'leader' && work.participantId !== participant.id)) fail('TEAM_WORK_NOT_FOUND', 'This work is not available to this participant.');
    return clone(work!);
  }
  async waitForInformation(actor: TeamRuntimeActor, workId: string): Promise<TeamRuntimeWork> {
    return this.mutate(state => {
      const { activation, participant } = this.actor(state, actor);
      const work = activation.works.find(w => w.id === workId && w.participantId === participant.id);
      if (!work || !running(work)) fail('TEAM_WORK_NOT_RUNNING', 'Only the executing Teammate can wait for information on its current work.');
      work!.status = 'waiting_information';
      return clone(work!);
    });
  }
  async send(actor: TeamRuntimeActor, input: { recipientId: string; text: string; replyTo?: string; workId?: string; requestToken: string }): Promise<TeamRuntimeMessage> {
    return this.sendOrRelay(actor, input);
  }
  async relay(actor: TeamRuntimeActor, input: { messageId: string; text?: string; recipientId?: string; requestToken: string }): Promise<TeamRuntimeMessage> {
    return this.sendOrRelay(actor, input);
  }
  private async sendOrRelay(actor: TeamRuntimeActor, input: { recipientId?: string; text?: string; replyTo?: string; workId?: string; messageId?: string; requestToken: string }): Promise<TeamRuntimeMessage> {
    text(input.requestToken, 'requestToken', { max: 500 });
    if (input.text !== undefined) text(input.text, 'text');
    const result = await this.mutate(state => {
      const { activation, participant } = this.actor(state, actor);
      const source = input.messageId ? activation.messages.find(m => m.id === input.messageId) : undefined;
      if (input.messageId && (participant.role !== 'leader' || !source || source.recipientId !== participant.id)) fail('TEAM_RELAY_FORBIDDEN', 'Only the receiving Leader can relay a message.');
      const intendedId = input.recipientId ?? source?.intendedRecipientId;
      const intended = activation.participants.find(p => p.id === intendedId);
      if (!intended || intended.id === participant.id) throw new TeamError('TEAM_RECIPIENT_INVALID', 'Choose another participant from this activation.');
      const leader = activation.participants.find(p => p.role === 'leader')!;
      const recipient = participant.role === 'teammate' && intended.role === 'teammate' ? leader : intended;
      if (input.replyTo && !activation.messages.some(m => m.id === input.replyTo && (m.senderId === participant.id || m.recipientId === participant.id))) fail('TEAM_MESSAGE_NOT_FOUND', 'The reply target is not available to this participant.');
      if (input.workId && !activation.works.some(w => w.id === input.workId && (participant.role === 'leader' || w.participantId === participant.id))) fail('TEAM_WORK_NOT_FOUND', 'This work is not available to this participant.');
      const requestHash = hash(input), scope = `message:${activation.id}:${participant.id}`;
      const existing = this.receipt(state, scope, input.requestToken, requestHash);
      if (existing !== undefined) return clone(existing as TeamRuntimeMessage);
      const message: TeamRuntimeMessage = { id: randomUUID(), senderId: source?.senderId ?? participant.id, recipientId: recipient.id, intendedRecipientId: intended.id, text: text(input.text ?? source?.text, 'text'), ...(input.replyTo ? { replyTo: input.replyTo } : {}), ...(source ? { relayOf: source.id } : {}), ...((input.workId ?? source?.workId) ? { workId: input.workId ?? source?.workId } : {}), createdAt: now(), status: 'queued' };
      activation.messages.push(message); activation.updatedAt = now();
      if (recipient.role === 'leader') activation.notifications.push({ id: randomUUID(), kind: 'message', messageId: message.id, participantId: participant.id, summary: recipient.id === intended.id ? 'New message for the Leader.' : 'Peer message awaiting explicit Leader relay.', createdAt: now() });
      this.saveReceipt(state, scope, input.requestToken, requestHash, message);
      return clone(message);
    });
    this.schedule(actor.activationId);
    return result;
  }

  private actor(state: RuntimeState, actor: TeamRuntimeActor, requireActive = true) {
    const activation = this.activation(state, actor.sessionKey, actor.activationId);
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
      const result = await body(state);
      if (!this.disposed && before !== hash(state)) await this.store.write(state);
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
    const snapshot = await this.store.read();
    if (this.disposed || Object.keys(snapshot.activations).length === 0) return;
    await this.store.locked(async () => {
      const state = await this.store.read(); let changed = false;
      for (const activation of Object.values(state.activations)) {
        if (activation.stopVersion === undefined) { activation.stopVersion = 0; changed = true; }
        for (const work of activation.works) if (running(work) && !this.ownerAlive(work.owner)) {
          work.status = 'interrupted'; work.error = 'Execution interrupted. Review the saved context and continue explicitly; it was not replayed.'; work.endedAt = now(); delete work.owner; changed = true;
          activation.notifications.push(this.workNotification(work));
        }
        for (const message of activation.messages) if (message.owner && !this.ownerAlive(message.owner)) { message.status = 'interrupted'; delete message.owner; changed = true; }
        for (const notification of activation.notifications) if (notification.owner && !this.ownerAlive(notification.owner)) { delete notification.owner; changed = true; }
      }
      if (changed && !this.disposed) await this.store.write(state);
      // Recovery only replays observations and unstarted queued work, never uncertain execution.
      queueMicrotask(() => { for (const activation of Object.values(state.activations)) if (activation.status === 'active') this.schedule(activation.id); });
    });
  }
  private schedule(activationId: string) {
    if (this.disposed) return;
    void this.ready.then(async () => {
      if (this.disposed) return;
      const activation = (await this.store.read()).activations[activationId];
      if (this.disposed || !activation || activation.status !== 'active') return;
      for (const participant of activation.participants.filter(p => p.role === 'teammate')) {
        const key = `${activationId}:${participant.id}`;
        const hasPending = activation.works.some(w => w.participantId === participant.id && w.status === 'queued') || activation.messages.some(m => m.recipientId === participant.id && m.status === 'queued' && !m.owner);
        const alreadyRunning = activation.works.some(w => w.participantId === participant.id && running(w)) || activation.messages.some(m => m.recipientId === participant.id && m.owner);
        if (hasPending && !alreadyRunning && !this.drains.has(key)) {
          const drain = this.drain(activationId, participant.id).catch(() => { /* Durable records remain available for recovery. */ }).finally(() => { this.drains.delete(key); this.schedule(activationId); });
          this.drains.set(key, drain);
        }
      }
      if (activation.notifications.some(n => !n.deliveredAt && !n.cancelledAt)) void this.flush(activationId);
    }).catch(() => { /* Read errors surface through runtime_get and subsequent commands. */ });
  }
  private async drain(activationId: string, participantId: string): Promise<void> {
    while (!this.disposed) {
      const claim = await this.mutate(state => {
        const activation = state.activations[activationId];
        if (!activation || activation.status !== 'active' || state.sessions[activation.sessionKey] !== activationId) return null;
        if (activation.works.some(w => w.participantId === participantId && running(w)) || activation.messages.some(m => m.recipientId === participantId && m.owner)) return null;
        const incoming = activation.messages.filter(m => m.recipientId === participantId && m.status === 'queued');
        const waiting = activation.works.filter(w => w.participantId === participantId && w.status === 'waiting_information');
        const recipientWork = (workId: string | undefined) => activation.works.find(w => w.id === workId && w.participantId === participantId);
        // A peer message may carry its sender's work ID. Only a work owned by
        // this recipient routes execution; replies can recover that association
        // from the original question, including through an explicit relay.
        const relatedWorkId = (message: TeamRuntimeMessage, seen = new Set<string>()): string | undefined => {
          if (seen.has(message.id)) return undefined;
          seen.add(message.id);
          const direct = recipientWork(message.workId);
          if (direct) return direct.id;
          for (const reference of [message.replyTo, message.relayOf]) {
            const previous = activation.messages.find(m => m.id === reference);
            const related = previous ? relatedWorkId(previous, seen) : undefined;
            if (related) return related;
          }
          return undefined;
        };
        const routing = incoming.map(message => ({ message, workId: relatedWorkId(message) }));
        // With one waiting task, an unlabelled answer is unambiguous. With
        // several, deliver it as ordinary coordination and let the participant
        // ask for clarification instead of consuming another task's answer.
        const route = (item: (typeof routing)[number]) => item.workId ?? (waiting.length === 1 ? waiting[0]!.id : undefined);
        const selectedWorkId = routing.length ? route(routing[0]!) : undefined;
        const candidate = recipientWork(selectedWorkId);
        const work = incoming.length
          ? candidate && ['waiting_information', 'queued'].includes(candidate.status) ? candidate : undefined
          : activation.works.find(w => w.participantId === participantId && w.status === 'queued');
        const messages = routing.filter(item => route(item) === selectedWorkId).slice(0, 20).map(item => item.message);
        if (!work && !messages.length) return null;
        const owner = { pid: process.pid, instanceId: this.instanceId };
        if (work) { work.status = 'running'; work.startedAt ??= now(); work.owner = owner; }
        for (const message of messages) message.owner = owner;
        const participant = activation.participants.find(p => p.id === participantId)!;
        // A participant does not receive sibling work/results or the Leader transcript.
        const isolated = clone(activation);
        isolated.works = isolated.works.filter(w => w.participantId === participantId);
        isolated.messages = isolated.messages.filter(m => m.recipientId === participantId || m.senderId === participantId);
        isolated.notifications = [];
        return { activation: isolated, participant: clone(participant), work: work ? clone(work) : undefined, messages: clone(messages) };
      });
      if (!claim) return;
      const key = `${activationId}:${participantId}`, controller = new AbortController(); this.controllers.set(key, controller);
      let output: { text: string } | undefined, error: unknown;
      try {
        const latest = (await this.store.read()).activations[activationId];
        if (this.disposed || latest?.status !== 'active') controller.abort();
        if (controller.signal.aborted) throw new Error('Team execution stopped before starting.');
        output = await this.options.executeParticipant({ ...claim, signal: controller.signal, updateStatus: async status => {
          await this.mutate(state => { const work = state.activations[activationId]?.works.find(w => w.id === claim.work?.id); if (work?.owner?.instanceId === this.instanceId && pending(work)) work.status = status; });
        } });
      } catch (caught) { error = caught; }
      finally { this.controllers.delete(key); }
      await this.mutate(state => {
        const activation = state.activations[activationId]; if (!activation) return;
        const work = activation.works.find(w => w.id === claim.work?.id);
        const active = activation.status === 'active' && state.sessions[activation.sessionKey] === activationId && !controller.signal.aborted;
        if (work?.owner?.instanceId === this.instanceId && pending(work)) {
          work.status = this.disposed && activation.status === 'active' ? 'interrupted' : !active ? 'stopped' : error ? 'failed' : work.status === 'waiting_information' ? 'waiting_information' : 'completed';
          if (error) work.error = error instanceof Error ? error.message : String(error);
          else work.result = output?.text ?? '';
          if (work.status !== 'waiting_information') work.endedAt = now(); delete work.owner;
          if (active && work.status !== 'waiting_information') activation.notifications.push(this.workNotification(work));
        }
        for (const message of activation.messages.filter(m => claim.messages.some(c => c.id === m.id))) if (message.owner?.instanceId === this.instanceId) {
          message.status = !active ? 'stopped' : error ? 'interrupted' : 'delivered'; if (message.status === 'delivered') message.deliveredAt = now(); delete message.owner;
        }
        activation.updatedAt = now();
      });
      await this.flush(activationId);
    }
  }
  private workNotification(work: TeamRuntimeWork): TeamRuntimeNotification {
    return { id: randomUUID(), kind: work.status === 'completed' ? 'work_completed' : 'work_failed', workId: work.id, participantId: work.participantId, summary: `${work.status}: ${work.task.slice(0, 160)}`, createdAt: now() };
  }
  private flush(activationId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.flushes.get(activationId); if (existing) { this.flushRequested.add(activationId); return existing; }
    const promise = this.flushNotifications(activationId).catch(() => { /* Keep the outbox pending for the next safe boundary. */ }).finally(() => {
      this.flushes.delete(activationId);
      // An external event arriving during a failed/busy delivery must not be
      // lost. Retry once for that event, never continuously poll a busy Leader.
      if (this.flushRequested.delete(activationId)) void this.flush(activationId);
    });
    this.flushes.set(activationId, promise); return promise;
  }
  private async flushNotifications(activationId: string): Promise<void> {
    while (!this.disposed) {
      const snapshot = (await this.store.read()).activations[activationId];
      if (this.disposed || !snapshot || snapshot.status !== 'active' || !snapshot.notifications.some(n => !n.deliveredAt && !n.cancelledAt)) return;
      const claim = await this.mutate(state => {
        const activation = state.activations[activationId];
        if (!activation || activation.status !== 'active' || state.sessions[activation.sessionKey] !== activationId || activation.automaticWakeups >= (this.options.maxAutomaticWakeups ?? 24)) return null;
        if (activation.notifications.some(n => n.owner)) return null;
        const pendingNotifications = activation.notifications.filter(n => !n.deliveredAt && !n.cancelledAt);
        const existingBatch = pendingNotifications.find(n => n.batchId)?.batchId;
        const notifications = (existingBatch ? pendingNotifications.filter(n => n.batchId === existingBatch) : pendingNotifications).slice(0, 30);
        if (!notifications.length) return null;
        const batchId = existingBatch ?? randomUUID();
        for (const notification of notifications) { notification.owner = { pid: process.pid, instanceId: this.instanceId }; notification.batchId = batchId; }
        return { activation: clone(activation), notifications: clone(notifications) };
      });
      if (!claim) return;
      const controller = new AbortController(), key = `${activationId}:notifications`; this.controllers.set(key, controller);
      let delivered = false;
      try {
        const latest = (await this.store.read()).activations[activationId];
        if (this.disposed || latest?.status !== 'active') controller.abort();
        if (!controller.signal.aborted) delivered = await this.options.notifyLeader({ ...claim, signal: controller.signal });
      }
      finally {
        this.controllers.delete(key);
        await this.mutate(state => {
          const activation = state.activations[activationId]; if (!activation) return;
          for (const notification of activation.notifications.filter(n => claim.notifications.some(c => c.id === n.id))) if (notification.owner?.instanceId === this.instanceId) {
            delete notification.owner;
            if (delivered && !controller.signal.aborted && activation.status === 'active') {
              notification.deliveredAt = now();
              const message = activation.messages.find(m => m.id === notification.messageId);
              if (message?.status === 'queued') { message.status = 'delivered'; message.deliveredAt = now(); }
            }
          }
          if (delivered && !controller.signal.aborted && activation.status === 'active') activation.automaticWakeups++;
        });
      }
      if (!delivered || controller.signal.aborted) return;
    }
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
