import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PilotDeckTeamMessage,
  PilotDeckTeamMessageActor,
  PilotDeckTeamMessageKind,
  PilotDeckTeamMessageSnapshot,
  PilotDeckTeamMessageStatus,
  PilotDeckTeamPermissionSnapshot,
} from "../../tool/protocol/types.js";

export type TeamMessageStoreOptions = {
  path: string;
  now?: () => Date;
};

const VERSION = 1 as const;
const KINDS = new Set<PilotDeckTeamMessageKind>([
  "explicit",
  "completion",
  "failure",
  "cancelled",
]);
const STATUSES = new Set<PilotDeckTeamMessageStatus>(["pending", "delivered", "failed"]);

export class TeamMessageStore {
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TeamMessageStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<PilotDeckTeamMessageSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.options.path, "utf8")) as unknown;
      return normalizeSnapshot(parsed, this.now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptySnapshot(this.now);
    }
  }

  async enqueue(message: PilotDeckTeamMessage): Promise<PilotDeckTeamMessage> {
    let result = message;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const existing = current.messages.find((entry) => entry.id === message.id);
      if (existing) {
        result = existing;
        return;
      }
      await atomicWriteJson(this.options.path, {
        version: VERSION,
        messages: [...current.messages, message],
        updatedAt: this.now().toISOString(),
      } satisfies PilotDeckTeamMessageSnapshot);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async listPending(recipient?: PilotDeckTeamMessageActor): Promise<PilotDeckTeamMessage[]> {
    const snapshot = await this.read();
    return snapshot.messages.filter((message) =>
      message.status === "pending"
      && (!recipient || sameActor(message.to, recipient)));
  }

  async markDelivered(messageIds: string[]): Promise<PilotDeckTeamMessage[]> {
    const ids = new Set(messageIds);
    if (ids.size === 0) return [];
    let delivered: PilotDeckTeamMessage[] = [];
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const timestamp = this.now().toISOString();
      delivered = [];
      const messages = current.messages.map((message) => {
        if (!ids.has(message.id) || message.status === "delivered") return message;
        const updated: PilotDeckTeamMessage = {
          ...message,
          status: "delivered",
          deliveredAt: timestamp,
          updatedAt: timestamp,
        };
        delivered.push(updated);
        return updated;
      });
      await atomicWriteJson(this.options.path, {
        version: VERSION,
        messages,
        updatedAt: timestamp,
      } satisfies PilotDeckTeamMessageSnapshot);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return delivered;
  }

  async markFailed(messageIds: string[], failureReason: string): Promise<PilotDeckTeamMessage[]> {
    const ids = new Set(messageIds);
    if (ids.size === 0) return [];
    let failed: PilotDeckTeamMessage[] = [];
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const timestamp = this.now().toISOString();
      failed = [];
      const messages = current.messages.map((message) => {
        if (!ids.has(message.id) || message.status !== "pending") return message;
        const updated: PilotDeckTeamMessage = {
          ...message,
          status: "failed",
          failureReason,
          updatedAt: timestamp,
        };
        failed.push(updated);
        return updated;
      });
      await atomicWriteJson(this.options.path, {
        version: VERSION,
        messages,
        updatedAt: timestamp,
      } satisfies PilotDeckTeamMessageSnapshot);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return failed;
  }
}

function emptySnapshot(now: () => Date): PilotDeckTeamMessageSnapshot {
  return { version: VERSION, messages: [], updatedAt: now().toISOString() };
}

function normalizeSnapshot(
  value: unknown,
  now: () => Date,
): PilotDeckTeamMessageSnapshot {
  if (!isRecord(value)) return emptySnapshot(now);
  return {
    version: VERSION,
    messages: Array.isArray(value.messages)
      ? value.messages.flatMap(normalizeMessage)
      : [],
    updatedAt: typeof value.updatedAt === "string"
      ? value.updatedAt
      : now().toISOString(),
  };
}

function normalizeMessage(value: unknown): PilotDeckTeamMessage[] {
  if (!isRecord(value)) return [];
  const required = [
    "id",
    "leaderSessionId",
    "text",
    "createdAt",
    "updatedAt",
  ] as const;
  if (required.some((key) => typeof value[key] !== "string")) return [];
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as PilotDeckTeamMessageKind)) {
    return [];
  }
  if (
    typeof value.status !== "string"
    || !STATUSES.has(value.status as PilotDeckTeamMessageStatus)
  ) {
    return [];
  }
  const from = normalizeActor(value.from);
  const to = normalizeActor(value.to);
  if (!from || !to) return [];
  return [{
    id: value.id as string,
    leaderSessionId: value.leaderSessionId as string,
    from,
    to,
    kind: value.kind as PilotDeckTeamMessageKind,
    text: value.text as string,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(normalizePermission(value.permission)
      ? { permission: normalizePermission(value.permission) }
      : {}),
    status: value.status as PilotDeckTeamMessageStatus,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    ...(typeof value.deliveredAt === "string"
      ? { deliveredAt: value.deliveredAt }
      : {}),
    ...(typeof value.failureReason === "string"
      ? { failureReason: value.failureReason }
      : {}),
  }];
}

function normalizePermission(value: unknown): PilotDeckTeamPermissionSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.rules)) return undefined;
  if (
    value.permissionMode !== "default"
    && value.permissionMode !== "plan"
    && value.permissionMode !== "bypassPermissions"
  ) {
    return undefined;
  }
  if (
    value.basePermissionMode !== "default"
    && value.basePermissionMode !== "plan"
    && value.basePermissionMode !== "bypassPermissions"
  ) {
    return undefined;
  }
  if (!Array.isArray(value.rules.allow) || !Array.isArray(value.rules.deny) || !Array.isArray(value.rules.ask)) {
    return undefined;
  }
  return value as PilotDeckTeamPermissionSnapshot;
}

function normalizeActor(value: unknown): PilotDeckTeamMessageActor | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string") {
    return undefined;
  }
  if (value.role === "leader" && value.id === "leader") {
    return { role: "leader", id: "leader", sessionId: value.sessionId };
  }
  if (value.role === "teammate") {
    return { role: "teammate", id: value.id, sessionId: value.sessionId };
  }
  return undefined;
}

function sameActor(
  left: PilotDeckTeamMessageActor,
  right: PilotDeckTeamMessageActor,
): boolean {
  return left.role === right.role
    && left.id === right.id
    && left.sessionId === right.sessionId;
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
