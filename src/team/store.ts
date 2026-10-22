import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProfile, TeamDefinition } from './types.js';
import { TeamError } from './validation.js';

export type Receipt = { token: string; hash: string; result: AgentProfile | TeamDefinition };
export type LibraryState = { version: 2; profiles: Record<string, AgentProfile[]>; teams: Record<string, TeamDefinition[]>; receipts: Receipt[] };
type LegacyState = Omit<LibraryState, "version" | "receipts"> & { version: 1; receipts: Array<Omit<Receipt, "result"> & { result: Receipt["result"] | { conversationId: string } }> };

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex'); }

async function atomicFile(file: string, contents: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    // Windows does not support opening directories through fs.open for fsync.
    // The file itself is flushed before the atomic rename on every platform.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

async function atomicJson(file: string, value: unknown): Promise<void> { await atomicFile(file, JSON.stringify(value)); }

type Ticket = { pid: number; choosing: boolean; number: number };
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Each contender owns a distinct file; recovering a dead owner cannot unlink a new owner's lock. */
export class TeamStore {
  readonly directory: string;
  private readonly stateFile: string;
  constructor(pilotHome: string) {
    this.directory = path.join(pilotHome, 'team-library');
    this.stateFile = path.join(this.directory, 'state.json');
  }

  private async readEnvelope(): Promise<{ raw: string; state: LibraryState | LegacyState } | null> {
    let raw: string;
    try { raw = await readFile(this.stateFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const envelope = JSON.parse(raw) as { checksum: string; state: LibraryState | LegacyState };
      const state = envelope.state;
      if (!state || (state.version !== 1 && state.version !== 2) || !state.profiles || !state.teams || !Array.isArray(state.receipts) || envelope.checksum !== hash(state)) throw new Error('invalid state or checksum');
      for (const entries of [...Object.values(state.profiles), ...Object.values(state.teams)]) if (!Array.isArray(entries) || entries.length === 0) throw new Error('invalid version history');
      return { raw, state };
    } catch (error) { throw new TeamError('TEAM_STORE_CORRUPT', `Team library cannot be read: ${(error as Error).message}`); }
  }

  private configurationState(state: LibraryState | LegacyState): LibraryState {
    if (state.version === 2) return state;
    return {
      version: 2,
      profiles: state.profiles,
      teams: state.teams,
      receipts: state.receipts.filter((receipt): receipt is Receipt => !('conversationId' in receipt.result)),
    };
  }

  /** Reads have no side effects; the next locked operation upgrades legacy storage. */
  async read(): Promise<LibraryState> {
    const envelope = await this.readEnvelope();
    return envelope ? this.configurationState(envelope.state) : { version: 2, profiles: {}, teams: {}, receipts: [] };
  }

  private async migrateLegacyState(): Promise<void> {
    const envelope = await this.readEnvelope();
    if (!envelope || envelope.state.version === 2) return;
    // Keep the original bytes, including retired data, before any replacement.
    // Content-addressed names make retries safe after an interrupted migration.
    await atomicFile(path.join(this.directory, `state.v1.${hash(envelope.raw)}.backup.json`), envelope.raw);
    await this.write(this.configurationState(envelope.state));
  }

  async write(state: LibraryState): Promise<void> { await atomicJson(this.stateFile, { checksum: hash(state), state }); }

  async locked<T>(body: () => Promise<T>): Promise<T> {
    const locks = path.join(this.directory, 'locks');
    await mkdir(locks, { recursive: true });
    const id = randomUUID();
    const file = path.join(locks, `${id}.json`);
    const ticket: Ticket = { pid: process.pid, choosing: true, number: 0 };
    const readTicket = async (name: string): Promise<Ticket | null> => {
      try {
        const other = JSON.parse(await readFile(path.join(locks, name), 'utf8')) as Ticket;
        if (!Number.isSafeInteger(other.pid) || other.pid < 1 || typeof other.choosing !== 'boolean' || !Number.isSafeInteger(other.number) || other.number < 0) throw new Error('invalid lock ticket');
        if (!alive(other.pid)) { await unlink(path.join(locks, name)).catch(() => {}); return null; }
        return other;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new TeamError('TEAM_LOCK_INVALID', `Team library lock cannot be read: ${(error as Error).message}`); }
    };
    try {
      await atomicJson(file, ticket);
      const names = (await readdir(locks)).filter(name => name.endsWith('.json'));
      const current = await Promise.all(names.map(readTicket));
      ticket.number = Math.max(0, ...current.map(item => item?.number ?? 0)) + 1;
      ticket.choosing = false;
      await atomicJson(file, ticket);
      const deadline = Date.now() + 120_000;
      for (const name of (await readdir(locks)).filter(name => name.endsWith('.json') && name !== `${id}.json`)) {
        for (;;) {
          const other = await readTicket(name);
          if (!other || (!other.choosing && (other.number > ticket.number || (other.number === ticket.number && name > `${id}.json`)))) break;
          if (Date.now() >= deadline) throw new TeamError('TEAM_BUSY', 'Team library is busy. Retry this operation.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      await this.migrateLegacyState();
      return await body();
    } finally { await unlink(file).catch(() => {}); }
  }
}
