import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProfile, TeamDefinition } from './types.js';
import { TeamError } from './validation.js';

/** The library stores one current configuration per identity. Runtime snapshots are separate. */
export type Receipt = { token: string; hash: string; result: AgentProfile | TeamDefinition };
export type LibraryState = { version: 2; profiles: Record<string, AgentProfile>; teams: Record<string, TeamDefinition>; receipts: Receipt[] };

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
    if (process.platform !== 'win32') { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await unlink(temp).catch(() => {}); }
}

type Ticket = { pid: number; choosing: boolean; number: number };
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function cleanRef(value: { id: string }): { id: string } { return { id: value.id }; }
function cleanProfile(value: any): AgentProfile { const { revision: _revision, archived: _archived, forkedFrom: _forkedFrom, ...profile } = value; return profile as AgentProfile; }
function cleanTeam(value: any): TeamDefinition { const { revision: _revision, archived: _archived, forkedFrom: _forkedFrom, ...team } = value; return { ...team, config: { ...team.config, leader: cleanRef(team.config.leader), teammates: team.config.teammates.map(cleanRef) }, leader: cleanProfile(team.leader), teammates: team.teammates.map(cleanProfile) } as TeamDefinition; }
function latest<T>(value: T | T[]): T { return Array.isArray(value) ? value.at(-1)! : value; }
function normalizeState(raw: any): LibraryState {
  const profiles: Record<string, AgentProfile> = {};
  for (const [id, value] of Object.entries(raw.profiles ?? {})) profiles[id] = cleanProfile(latest(value as AgentProfile | AgentProfile[]));
  const teams: Record<string, TeamDefinition> = {};
  for (const [id, value] of Object.entries(raw.teams ?? {})) teams[id] = cleanTeam(latest(value as TeamDefinition | TeamDefinition[]));
  const receipts: Receipt[] = (raw.receipts ?? []).filter((item: any) => item?.result && !('conversationId' in item.result)).map((item: any) => ({ token: item.token, hash: item.hash, result: 'role' in item.result ? cleanProfile(item.result) : cleanTeam(item.result) })).filter((item: Receipt) => item.result);
  return { version: 2, profiles, teams, receipts };
}

export class TeamStore {
  readonly directory: string;
  private readonly stateFile: string;
  constructor(pilotHome: string) { this.directory = path.join(pilotHome, 'team-library'); this.stateFile = path.join(this.directory, 'state.json'); }
  private async readEnvelope(): Promise<{ raw: string; state: LibraryState } | null> {
    let raw: string;
    try { raw = await readFile(this.stateFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try { const envelope = JSON.parse(raw) as { checksum: string; state: any }; if (!envelope.state || ![1, 2].includes(envelope.state.version) || envelope.checksum !== hash(envelope.state)) throw new Error('invalid state or checksum'); return { raw, state: normalizeState(envelope.state) }; }
    catch (error) { throw new TeamError('TEAM_STORE_CORRUPT', `Team library cannot be read: ${(error as Error).message}`); }
  }
  async read(): Promise<LibraryState> { const envelope = await this.readEnvelope(); return envelope?.state ?? { version: 2, profiles: {}, teams: {}, receipts: [] }; }
  async write(state: LibraryState): Promise<void> { await atomicFile(this.stateFile, JSON.stringify({ checksum: hash(state), state: normalizeState(state) })); }
  async locked<T>(body: () => Promise<T>): Promise<T> {
    const locks = path.join(this.directory, 'locks'); await mkdir(locks, { recursive: true }); const id = randomUUID(), file = path.join(locks, `${id}.json`), ticket: Ticket = { pid: process.pid, choosing: true, number: 0 };
    const readTicket = async (name: string): Promise<Ticket | null> => { try { const other = JSON.parse(await readFile(path.join(locks, name), 'utf8')) as Ticket; if (!Number.isSafeInteger(other.pid) || other.pid < 1 || typeof other.choosing !== 'boolean' || !Number.isSafeInteger(other.number) || other.number < 0) throw new Error('invalid lock ticket'); if (!alive(other.pid)) { await unlink(path.join(locks, name)).catch(() => {}); return null; } return other; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new TeamError('TEAM_LOCK_INVALID', `Team library lock cannot be read: ${(error as Error).message}`); } };
    try { await atomicFile(file, JSON.stringify(ticket)); const current = await Promise.all((await readdir(locks)).filter(name => name.endsWith('.json')).map(readTicket)); ticket.number = Math.max(0, ...current.map(item => item?.number ?? 0)) + 1; ticket.choosing = false; await atomicFile(file, JSON.stringify(ticket)); const deadline = Date.now() + 120_000; for (const name of (await readdir(locks)).filter(name => name.endsWith('.json') && name !== `${id}.json`)) for (;;) { const other = await readTicket(name); if (!other || (!other.choosing && (other.number > ticket.number || (other.number === ticket.number && name > `${id}.json`)))) break; if (Date.now() >= deadline) throw new TeamError('TEAM_BUSY', 'Team library is busy. Retry this operation.'); await new Promise(resolve => setTimeout(resolve, 20)); } return await body(); } finally { await unlink(file).catch(() => {}); }
  }
}
