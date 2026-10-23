import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TeamStore, hash } from './store.js';
import { TeamError } from './validation.js';
import type { TeamRuntimeActivation } from './runtimeTypes.js';

export type RuntimeReceipt = { token: string; hash: string; result: unknown };
export type RuntimeState = {
  version: 1;
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {}, activations: {}, receipts: {} };
      throw error;
    }
    try {
      const envelope = JSON.parse(raw) as { checksum: string; state: RuntimeState };
      const s = envelope.state;
      if (!s || s.version !== 1 || !s.sessions || !s.activations || !s.receipts || envelope.checksum !== hash(s)) throw new Error('invalid journal or checksum');
      for (const [key, activation] of Object.entries(s.activations)) {
        if (activation.id !== key || !Array.isArray(activation.participants) || !Array.isArray(activation.works) || !Array.isArray(activation.messages) || !Array.isArray(activation.notifications)) throw new Error('invalid activation');
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
