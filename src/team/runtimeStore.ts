import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TeamStore, hash } from './store.js';
import { TeamError } from './validation.js';
import type { TeamRuntimeActivation } from './runtimeTypes.js';

export type RuntimeReceipt = { token: string; hash: string; result: unknown };
export type RuntimeState = {
  version: 1 | 2 | 3;
  sessions: Record<string, string | null>;
  activations: Record<string, TeamRuntimeActivation>;
  receipts: Record<string, RuntimeReceipt[]>;
};

/** A separate, checksummed journal. Library edits cannot replace runtime state. */
export class TeamRuntimeStore {
  readonly directory: string;
  private readonly file: string;
  private readonly mutex: TeamStore;
  constructor(pilotHome: string) {
    this.directory = path.join(pilotHome, 'team-runtime');
    this.file = path.join(this.directory, 'state.json');
    this.mutex = new TeamStore(path.join(this.directory, 'mutex'));
  }
  locked<T>(body: () => Promise<T>): Promise<T> { return this.mutex.locked(body); }
  async read(): Promise<RuntimeState> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 3, sessions: {}, activations: {}, receipts: {} };
      throw error;
    }
    try {
      const envelope = JSON.parse(raw) as { checksum: string; state: RuntimeState };
      const s = envelope.state;
      if (!s || ![1, 2, 3].includes(s.version) || !s.sessions || !s.activations || !s.receipts || envelope.checksum !== hash(s)) throw new Error('invalid journal or checksum');
      const validOwner = (owner: unknown) => {
        if (owner === undefined) return true;
        if (!owner || typeof owner !== 'object') return false;
        const item = owner as { pid?: number; instanceId?: string; executionId?: string };
        return Number.isSafeInteger(item.pid) && Number(item.pid) > 0 && typeof item.instanceId === 'string' && item.instanceId.length > 0 && (item.executionId === undefined || typeof item.executionId === 'string');
      };
      for (const [key, activation] of Object.entries(s.activations)) {
        if (!activation || activation.id !== key || typeof activation.sessionKey !== 'string' || !Array.isArray(activation.participants) || !Array.isArray(activation.works) || !Array.isArray(activation.messages) || !Array.isArray(activation.notifications)) throw new Error('invalid activation');
        // Runtime journals written before human interactions were introduced
        // remain readable.  The next TeamRuntime mutation upgrades them.
        activation.interactions ??= [];
        activation.turns ??= [];
        activation.dispatches ??= [];
        if (!Array.isArray(activation.turns) || !Array.isArray(activation.dispatches)) throw new Error('invalid execution records');
        if (!Array.isArray(activation.interactions)) throw new Error('invalid interactions');
        if (!['active', 'stopping', 'stopped', 'closed'].includes(activation.status) || ((s.version >= 2 || activation.stopVersion !== undefined) && (!Number.isSafeInteger(activation.stopVersion) || activation.stopVersion < 0))) throw new Error('invalid activation lifecycle');
        if (!validOwner(activation.runtimeOwner)) throw new Error('invalid runtime owner');
        for (const items of [activation.works, activation.messages, activation.notifications]) {
          if (new Set(items.map(item => item?.id)).size !== items.length) throw new Error('duplicate runtime record');
          for (const item of items) {
            if (!item || typeof item.id !== 'string' || !item.id || !validOwner(item.owner)) throw new Error('invalid runtime record');
            if ((s.version >= 2 || item.stopVersion !== undefined) && (!Number.isSafeInteger(item.stopVersion) || item.stopVersion < 0 || item.stopVersion > (activation.stopVersion ?? 0))) throw new Error('invalid record generation');
          }
        }
        if (activation.works.some(work => !['queued', 'running', 'waiting_information', 'waiting_approval', 'completed', 'failed', 'interrupted', 'stopped'].includes(work.status))) throw new Error('invalid work status');
        if (activation.messages.some(message => !['queued', 'preparing', 'sending', 'consumed', 'invalidated', 'deleted', 'uncertain', 'legacy_unknown', 'delivered', 'interrupted', 'stopped'].includes(message.status))) throw new Error('invalid message status');
        const member = (id: string) => activation.participants.some(participant => participant.id === id);
        const generation = (version: number) => Number.isSafeInteger(version) && version >= 0 && version <= (activation.stopVersion ?? 0);
        const ids = (values: unknown) => Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;
        if (new Set(activation.turns.map(turn => `${turn.participantId}:${turn.turnId}`)).size !== activation.turns.length || activation.turns.some(turn => !turn || typeof turn.turnId !== 'string' || !turn.turnId || !member(turn.participantId) || !generation(turn.stopVersion) || !ids(turn.messageIds) || !ids(turn.requestIds) || (turn.attemptIds !== undefined && !ids(turn.attemptIds)) || (turn.pendingMessageIds !== undefined && !ids(turn.pendingMessageIds)) || !['human', 'messages'].includes(turn.trigger) || !['preparing', 'running', 'waiting_approval', 'ended', 'interrupted', 'stopped'].includes(turn.status) || !validOwner(turn.owner))) throw new Error('invalid execution turn');
        if (new Set(activation.dispatches.map(dispatch => `${dispatch.participantId}:${dispatch.attemptId ?? dispatch.requestId}`)).size !== activation.dispatches.length || activation.dispatches.some(dispatch => !dispatch || typeof dispatch.requestId !== 'string' || !dispatch.requestId || (dispatch.attemptId !== undefined && (typeof dispatch.attemptId !== 'string' || !dispatch.attemptId)) || typeof dispatch.turnId !== 'string' || !dispatch.turnId || !member(dispatch.participantId) || !generation(dispatch.stopVersion) || !ids(dispatch.messageIds) || !['sending', 'consumed', 'uncertain'].includes(dispatch.status))) throw new Error('invalid model dispatch');
        if (activation.notifications.some(notice => !['work_completed', 'work_failed', 'message'].includes(notice.kind))) throw new Error('invalid notification kind');
        if (activation.interactions.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.requestId !== 'string' || !item.requestId || typeof item.participantId !== 'string' || !item.participantId || !activation.participants.some(participant => participant.id === item.participantId && participant.role === 'teammate') || !['tool_permission', 'user_question', 'plan_approval'].includes(item.kind) || !['pending', 'allowed', 'denied', 'answered', 'approved', 'declined', 'cancelled', 'expired', 'failed'].includes(item.status) || item.activationId !== activation.id || item.sessionKey !== activation.sessionKey || !Number.isSafeInteger(item.stopVersion) || item.stopVersion < 0 || item.stopVersion > (activation.stopVersion ?? 0))) throw new Error('invalid interaction');
      }
      for (const id of Object.values(s.sessions)) if (id !== null && !s.activations[id]) throw new Error('missing activation');
      return s;
    } catch (error) { throw new TeamError('TEAM_RUNTIME_CORRUPT', `Team execution records cannot be read: ${(error as Error).message}`); }
  }
  async write(state: RuntimeState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ checksum: hash(state), state })); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
