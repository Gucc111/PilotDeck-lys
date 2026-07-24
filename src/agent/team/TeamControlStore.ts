import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PilotDeckTeamControlRequest,
  PilotDeckTeamControlRequestKind,
  PilotDeckTeamControlRequestStatus,
  PilotDeckTeamControlSnapshot,
} from "../../tool/protocol/types.js";

export type TeamControlStoreOptions = {
  path: string;
  now?: () => Date;
};

const VERSION = 1 as const;
const STATUSES = new Set<PilotDeckTeamControlRequestStatus>([
  "pending",
  "decided",
  "escalated",
  "resolved",
  "cancelled",
]);
const KINDS = new Set<PilotDeckTeamControlRequestKind>(["permission", "plan"]);

export class TeamControlStore {
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TeamControlStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<PilotDeckTeamControlSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.options.path, "utf8")) as unknown;
      return normalizeSnapshot(parsed, this.now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptySnapshot(this.now);
    }
  }

  async put(request: PilotDeckTeamControlRequest): Promise<PilotDeckTeamControlRequest> {
    let result = request;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const requests = current.requests.filter((entry) => entry.id !== request.id);
      requests.push(request);
      const snapshot: PilotDeckTeamControlSnapshot = {
        version: VERSION,
        requests,
        updatedAt: this.now().toISOString(),
      };
      await atomicWriteJson(this.options.path, snapshot);
      result = request;
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async update(
    requestId: string,
    update: (request: PilotDeckTeamControlRequest) => PilotDeckTeamControlRequest,
  ): Promise<PilotDeckTeamControlRequest> {
    let result: PilotDeckTeamControlRequest | undefined;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const index = current.requests.findIndex((entry) => entry.id === requestId);
      if (index < 0) throw new Error(`Unknown Team control request "${requestId}".`);
      result = update(current.requests[index]!);
      const requests = [...current.requests];
      requests[index] = result;
      await atomicWriteJson(this.options.path, {
        version: VERSION,
        requests,
        updatedAt: this.now().toISOString(),
      } satisfies PilotDeckTeamControlSnapshot);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result!;
  }
}

function emptySnapshot(now: () => Date): PilotDeckTeamControlSnapshot {
  return { version: VERSION, requests: [], updatedAt: now().toISOString() };
}

function normalizeSnapshot(value: unknown, now: () => Date): PilotDeckTeamControlSnapshot {
  if (!isRecord(value)) return emptySnapshot(now);
  return {
    version: VERSION,
    requests: Array.isArray(value.requests)
      ? value.requests.flatMap((entry) => normalizeRequest(entry))
      : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now().toISOString(),
  };
}

function normalizeRequest(value: unknown): PilotDeckTeamControlRequest[] {
  if (!isRecord(value)) return [];
  const required = [
    "id",
    "leaderSessionId",
    "teammateId",
    "teammateSessionId",
    "toolCallId",
    "toolName",
    "createdAt",
    "updatedAt",
  ] as const;
  if (required.some((key) => typeof value[key] !== "string")) return [];
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as PilotDeckTeamControlRequestKind)) return [];
  if (typeof value.status !== "string" || !STATUSES.has(value.status as PilotDeckTeamControlRequestStatus)) return [];
  return [value as PilotDeckTeamControlRequest];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
