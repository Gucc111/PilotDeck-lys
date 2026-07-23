import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getPilotTeammatesDir } from "../../pilot/paths.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_MS = 30_000;
const MIN_DEAD_OWNER_AGE_MS = 100;

type LockOwner = {
  token: string;
  pid: number;
  createdAt: number;
};

export type GlobalTeammateMutationLockOptions = {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleMs?: number;
};

export function getGlobalTeammateMutationLockPath(pilotHome: string): string {
  return resolve(getPilotTeammatesDir(pilotHome), ".global-mutation.lock");
}

/**
 * Cross-process mutex for all global teammate definition and enablement
 * mutations. The lock file lives beside the global teammate data and is
 * acquired with O_EXCL so independent PilotDeck processes share one order.
 */
export class GlobalTeammateMutationLock {
  readonly filePath: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleMs: number;

  constructor(filePath: string, options: GlobalTeammateMutationLockOptions = {}) {
    this.filePath = resolve(filePath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const owner = await this.acquire();
    try {
      return await operation();
    } finally {
      await this.release(owner);
    }
  }

  private async acquire(): Promise<LockOwner> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    };

    while (true) {
      try {
        const handle = await open(this.filePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.filePath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        return owner;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }

      await this.recoverStaleLock();
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for global teammate mutation lock at ${this.filePath}.`,
        );
      }
      await delay(Math.min(this.retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  private async recoverStaleLock(): Promise<void> {
    let ageMs: number;
    try {
      ageMs = Date.now() - (await stat(this.filePath)).mtimeMs;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }

    const observed = await readOwner(this.filePath);
    const deadOwner =
      observed !== null &&
      ageMs >= MIN_DEAD_OWNER_AGE_MS &&
      !isProcessAlive(observed.pid);
    const unreadableAndExpired = observed === null && ageMs >= this.staleMs;
    if (!deadOwner && !unreadableAndExpired) return;

    // Re-read the token immediately before unlinking so a released/reacquired
    // lock is not removed based on stale metadata from the previous owner.
    const current = await readOwner(this.filePath);
    if (
      observed !== null
        ? current?.token !== observed.token
        : current !== null
    ) {
      return;
    }
    await unlink(this.filePath).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }

  private async release(owner: LockOwner): Promise<void> {
    const current = await readOwner(this.filePath);
    if (current?.token !== owner.token) return;
    await unlink(this.filePath).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function readOwner(filePath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<LockOwner>;
    return (
      typeof value.token === "string" &&
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.createdAt === "number"
    )
      ? value as LockOwner
      : null;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}
