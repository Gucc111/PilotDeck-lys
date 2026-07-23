import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PilotDeckTeamProgressItem,
  PilotDeckTeamProgressSnapshot,
  PilotDeckTeamProgressUpdate,
} from "../../tool/protocol/types.js";

export type TeamProgressStoreOptions = {
  path: string;
  now?: () => Date;
};

const EMPTY_VERSION = 1 as const;

export class TeamProgressStore {
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: TeamProgressStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<PilotDeckTeamProgressSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.options.path, "utf8")) as unknown;
      return normalizeSnapshot(parsed, this.now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return emptySnapshot(this.now);
    }
  }

  async update(input: {
    items?: PilotDeckTeamProgressUpdate[];
    merge?: boolean;
    summary?: string | null;
  }): Promise<PilotDeckTeamProgressSnapshot> {
    let result = emptySnapshot(this.now);
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const current = await this.read();
      const timestamp = this.now().toISOString();
      const items = applyUpdates(current.items, input.items, Boolean(input.merge), timestamp);
      result = {
        version: EMPTY_VERSION,
        ...(input.summary === null
          ? {}
          : typeof input.summary === "string"
            ? { summary: input.summary.trim() }
            : current.summary
              ? { summary: current.summary }
              : {}),
        items,
        updatedAt: timestamp,
      };
      await atomicWriteJson(this.options.path, result);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

function emptySnapshot(now: () => Date): PilotDeckTeamProgressSnapshot {
  return {
    version: EMPTY_VERSION,
    items: [],
    updatedAt: now().toISOString(),
  };
}

function normalizeSnapshot(value: unknown, now: () => Date): PilotDeckTeamProgressSnapshot {
  if (!value || typeof value !== "object") {
    return emptySnapshot(now);
  }
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items)
    ? record.items.flatMap((item) => normalizeItem(item, now))
    : [];
  return {
    version: EMPTY_VERSION,
    ...(typeof record.summary === "string" && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    items,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now().toISOString(),
  };
}

function normalizeItem(value: unknown, now: () => Date): PilotDeckTeamProgressItem[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.content !== "string") return [];
  const statuses = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);
  const status = typeof record.status === "string" && statuses.has(record.status)
    ? record.status as PilotDeckTeamProgressItem["status"]
    : "pending";
  return [{
    id: record.id,
    content: record.content,
    status,
    ...(typeof record.teammateId === "string" ? { teammateId: record.teammateId } : {}),
    ...(Array.isArray(record.blockedBy)
      ? { blockedBy: record.blockedBy.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now().toISOString(),
  }];
}

function applyUpdates(
  current: PilotDeckTeamProgressItem[],
  updates: PilotDeckTeamProgressUpdate[] | undefined,
  merge: boolean,
  timestamp: string,
): PilotDeckTeamProgressItem[] {
  if (!updates) return current;
  const existing = merge ? new Map(current.map((item) => [item.id, item])) : new Map<string, PilotDeckTeamProgressItem>();
  const order = merge ? current.map((item) => item.id) : [];

  for (const update of updates) {
    const id = update.id.trim();
    if (!id) continue;
    const previous = existing.get(id);
    const content = update.content?.trim() ?? previous?.content;
    if (!content) {
      throw new Error(`Team progress item "${id}" requires content.`);
    }
    const next: PilotDeckTeamProgressItem = {
      id,
      content,
      status: update.status ?? previous?.status ?? "pending",
      ...(update.teammateId === null
        ? {}
        : update.teammateId !== undefined
          ? { teammateId: update.teammateId }
          : previous?.teammateId
            ? { teammateId: previous.teammateId }
            : {}),
      ...(update.blockedBy !== undefined
        ? { blockedBy: [...new Set(update.blockedBy.filter(Boolean))] }
        : previous?.blockedBy
          ? { blockedBy: previous.blockedBy }
          : {}),
      ...(update.summary === null
        ? {}
        : update.summary !== undefined
          ? { summary: update.summary }
          : previous?.summary
            ? { summary: previous.summary }
            : {}),
      updatedAt: timestamp,
    };
    existing.set(id, next);
    if (!order.includes(id)) order.push(id);
  }
  return order.map((id) => existing.get(id)).filter((item): item is PilotDeckTeamProgressItem => Boolean(item));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
