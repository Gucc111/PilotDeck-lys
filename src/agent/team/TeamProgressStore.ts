import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PilotDeckTeamProgressCounts,
  PilotDeckTeamProgressGetResult,
  PilotDeckTeamProgressItem,
  PilotDeckTeamProgressListItem,
  PilotDeckTeamProgressListResult,
  PilotDeckTeamProgressSnapshot,
  PilotDeckTeamProgressUpdate,
} from "../../tool/protocol/types.js";

export type TeamProgressStoreOptions = {
  path: string;
  now?: () => Date;
};

const VERSION = 2 as const;

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

  async list(): Promise<PilotDeckTeamProgressListResult> {
    return toProgressListResult(await this.read());
  }

  async get(taskId: string): Promise<PilotDeckTeamProgressGetResult> {
    const snapshot = await this.read();
    return {
      version: VERSION,
      task: snapshot.items.find((item) => item.id === taskId) ?? null,
      updatedAt: snapshot.updatedAt,
    };
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
        version: VERSION,
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
    version: VERSION,
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
    version: VERSION,
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
  if (typeof record.id !== "string") return [];
  const legacyContent = typeof record.content === "string"
    ? record.content.trim()
    : undefined;
  const subject = typeof record.subject === "string" && record.subject.trim()
    ? subjectFromText(record.subject.trim())
    : legacyContent
      ? subjectFromText(legacyContent)
      : undefined;
  if (!subject) return [];
  const statuses = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);
  const status = typeof record.status === "string" && statuses.has(record.status)
    ? record.status as PilotDeckTeamProgressItem["status"]
    : "pending";
  return [{
    id: record.id,
    subject,
    ...(typeof record.briefing === "string"
      ? { briefing: record.briefing }
      : legacyContent
        ? { briefing: legacyContent }
        : {}),
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
    const subjectCandidate = update.subject?.trim()
      ?? update.content?.trim()
      ?? previous?.subject;
    if (!subjectCandidate) {
      throw new Error(`Team progress item "${id}" requires subject.`);
    }
    const subject = subjectFromText(subjectCandidate);
    const next: PilotDeckTeamProgressItem = {
      id,
      subject,
      ...(update.briefing === null
        ? {}
        : update.briefing !== undefined
          ? { briefing: update.briefing }
          : previous?.briefing
            ? { briefing: previous.briefing }
            : {}),
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

export function toProgressListItem(
  item: PilotDeckTeamProgressItem,
  resolvedTaskIds: ReadonlySet<string> = new Set(),
): PilotDeckTeamProgressListItem {
  const {
    briefing: _briefing,
    summary: _summary,
    ...compact
  } = item;
  const blockedBy = compact.blockedBy?.filter(
    (taskId) => !resolvedTaskIds.has(taskId),
  );
  return {
    ...compact,
    ...(blockedBy ? { blockedBy } : {}),
  };
}

export function toProgressListResult(
  snapshot: PilotDeckTeamProgressSnapshot,
): PilotDeckTeamProgressListResult {
  const resolvedTaskIds = new Set(
    snapshot.items
      .filter((item) => item.status === "completed")
      .map((item) => item.id),
  );
  return {
    version: VERSION,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    items: snapshot.items.map((item) =>
      toProgressListItem(item, resolvedTaskIds)),
    counts: progressCounts(snapshot.items),
    updatedAt: snapshot.updatedAt,
  };
}

export function progressCounts(
  items: PilotDeckTeamProgressItem[],
): PilotDeckTeamProgressCounts {
  const counts: PilotDeckTeamProgressCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

function subjectFromText(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    ?? "Team task"
  ).slice(0, 160);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
