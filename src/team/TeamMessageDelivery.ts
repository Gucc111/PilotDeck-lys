import type { AgentEvent } from '../agent/protocol/events.js';
import type { AgentSteerResult } from '../agent/session/SteerMailbox.js';
import type { CanonicalMessage } from '../model/index.js';

/** Tracks durable application, not admission to the volatile steer mailbox. */
export class TeamMessageDelivery {
  private readonly pending = new Map<string, { turnId: string; promise: Promise<boolean>; finish: (applied: boolean, reason?: string) => void }>();

  observe(sessionKey: string, event: AgentEvent): void {
    if (event.type === 'steer_applied' || event.type === 'steer_unapplied') {
      const entry = this.pending.get(`${sessionKey}\0${event.itemId}`);
      if (entry?.turnId === event.turnId) entry.finish(event.type === 'steer_applied', event.type);
    } else if (event.type === 'turn_completed' || event.type === 'session_ended') {
      this.close(sessionKey, event.type === "turn_completed" ? event.turnId : undefined);
    }
  }

  close(sessionKey: string, turnId?: string): void {
    for (const [key, entry] of this.pending) {
      if (key.startsWith(`${sessionKey}\0`) && (!turnId || entry.turnId === turnId)) entry.finish(false, 'execution_closed');
    }
  }

  async deliver(input: {
    sessionKey: string; turnId: string; itemId: string; message: CanonicalMessage; signal: AbortSignal;
    isCurrent: () => Promise<boolean>;
    wasApplied: () => Promise<boolean>;
    enqueue: (beforeApply: () => Promise<boolean>) => AgentSteerResult;
    cancel: () => void;
  }): Promise<boolean> {
    if (input.signal.aborted || !await input.isCurrent()) return false;
    const key = `${input.sessionKey}\0${input.itemId}`;
    // An in-process retry must wait for steer_applied even if the transcript
    // append has already finished. Transcript recovery is for untracked work.
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    if (await input.wasApplied()) return !input.signal.aborted && await input.isCurrent();
    if (input.signal.aborted || !await input.isCurrent()) return false;
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: (applied: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const record = (state: string, reason?: string) => console.info('[team:delivery]', JSON.stringify({ at: new Date().toISOString(), state, reason, sessionKey: input.sessionKey, turnId: input.turnId, eventId: input.itemId, activationId: input.message.metadata?.teamActivationId, stopVersion: input.message.metadata?.teamStopVersion }));
    const abort = () => { input.cancel(); entry.finish(false, 'aborted'); };
    const entry = {
      turnId: input.turnId, promise,
      finish: (applied: boolean, reason?: string) => {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        input.signal.removeEventListener('abort', abort);
        record(applied && !input.signal.aborted ? 'applied' : 'unapplied', reason);
        resolve(applied && !input.signal.aborted);
      },
    };
    this.pending.set(key, entry);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    else {
      try {
        const admitted = input.enqueue(async () => !input.signal.aborted && await input.isCurrent());
        if (!admitted.accepted) entry.finish(false, admitted.reason);
        else record('enqueued');
      } catch (error) { entry.finish(false, 'enqueue_failed'); throw error; }
    }
    return promise;
  }
}
