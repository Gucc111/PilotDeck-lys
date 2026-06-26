import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DiscoveryPlanIndex, DiscoveryPlanRecord, DiscoveryPlanStatus, DiscoveryPlanWorkspaceRef } from "../../protocol/types.js";
import { planMarkdownPath, type AlwaysOnPaths } from "../AlwaysOnPaths.js";
import { atomicWriteJson, readJsonSafe } from "./JsonStoreBase.js";

const DEFAULT_INDEX: DiscoveryPlanIndex = { schemaVersion: 1, plans: [] };

const VALID_PLAN_STATUSES = new Set<string>([
  "ready", "executing", "completed", "completed_no_report", "failed", "applied", "archived",
]);

export class DiscoveryPlanStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async readIndex(): Promise<DiscoveryPlanIndex> {
    return readJsonSafe(
      this.paths.planIndexFile,
      () => cloneIndex(DEFAULT_INDEX),
      (parsed) => {
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).schemaVersion === 1 &&
          Array.isArray((parsed as DiscoveryPlanIndex).plans)
        ) {
          return normalizeIndex(parsed as DiscoveryPlanIndex);
        }
        return undefined;
      },
    );
  }

  async writeIndex(index: DiscoveryPlanIndex): Promise<void> {
    await atomicWriteJson(this.paths.planIndexFile, index);
  }

  async writePlanMarkdown(planId: string, markdown: string): Promise<string> {
    const filePath = planMarkdownPath(this.paths, planId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  async readPlanMarkdown(planId: string): Promise<string | undefined> {
    const filePath = planMarkdownPath(this.paths, planId);
    return safeReadFile(filePath);
  }

  async readPlanByPath(planFilePath: string): Promise<string | undefined> {
    const absolute = isAbsolute(planFilePath)
      ? planFilePath
      : resolve(this.paths.projectDir, planFilePath);
    return safeReadFile(absolute);
  }

  async upsert(record: DiscoveryPlanRecord): Promise<DiscoveryPlanRecord> {
    const index = await this.readIndex();
    const existingIndex = index.plans.findIndex((entry) => entry.id === record.id);
    const stored = freezeRecord(toRelativePaths(record, this.paths));
    if (existingIndex >= 0) {
      index.plans[existingIndex] = stored;
    } else {
      index.plans.push(stored);
    }
    await this.writeIndex(index);
    return stored;
  }

  async updateStatus(
    planId: string,
    update: {
      status?: DiscoveryPlanStatus;
      reportFilePath?: string;
      workCycleId?: string;
    },
  ): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    const target = index.plans.find((entry) => entry.id === planId);
    if (!target) return undefined;
    if (update.status !== undefined) {
      target.status = update.status;
      const raw = target as Record<string, unknown>;
      if ("executionStatus" in raw && (update.status === "completed" || update.status === "completed_no_report" || update.status === "failed")) {
        raw.executionStatus = update.status;
      }
    }
    if (update.reportFilePath !== undefined) {
      target.reportFilePath = relativeIfInsideRoot(update.reportFilePath, this.paths.projectDir);
    }
    if (update.workCycleId !== undefined) {
      target.workCycleId = update.workCycleId;
      delete target.workspace;
    }
    await this.writeIndex(index);
    return target;
  }

  async getRecord(planId: string): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    return index.plans.find((entry) => entry.id === planId);
  }

  async batchUpdateStatus(
    updates: Array<{ planId: string; status: DiscoveryPlanStatus; updatedAt?: string }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    const index = await this.readIndex();
    const updateMap = new Map(updates.map((u) => [u.planId, u]));
    for (const plan of index.plans) {
      const update = updateMap.get(plan.id);
      if (!update) continue;
      plan.status = update.status;
      if (update.updatedAt) {
        (plan as Record<string, unknown>).updatedAt = update.updatedAt;
      }
    }
    await this.writeIndex(index);
  }

  async updatePlanFields(
    planId: string,
    fields: Partial<Pick<DiscoveryPlanRecord, "status" | "reportFilePath" | "workCycleId" | "title" | "summary" | "rationale" | "dedupeKey">>,
  ): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    const target = index.plans.find((entry) => entry.id === planId);
    if (!target) return undefined;
    if (fields.status !== undefined) target.status = fields.status;
    if (fields.reportFilePath !== undefined) {
      target.reportFilePath = relativeIfInsideRoot(fields.reportFilePath, this.paths.projectDir);
    }
    if (fields.workCycleId !== undefined) {
      target.workCycleId = fields.workCycleId;
      delete target.workspace;
    }
    if (fields.title !== undefined) target.title = fields.title;
    if (fields.summary !== undefined) target.summary = fields.summary;
    if (fields.rationale !== undefined) target.rationale = fields.rationale;
    if (fields.dedupeKey !== undefined) target.dedupeKey = fields.dedupeKey;
    await this.writeIndex(index);
    return target;
  }
}

function normalizeIndex(index: DiscoveryPlanIndex): DiscoveryPlanIndex {
  return {
    schemaVersion: 1,
    plans: index.plans.map(normalizePlanRecord),
  };
}

function normalizePlanRecord(raw: Record<string, unknown>): DiscoveryPlanRecord {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    status: VALID_PLAN_STATUSES.has(raw.status as string)
      ? (raw.status as DiscoveryPlanStatus)
      : "ready",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : (typeof raw.id === "string" ? raw.id : ""),
    sourceRunId: typeof raw.sourceRunId === "string" ? raw.sourceRunId : "",
    planFilePath: typeof raw.planFilePath === "string" ? raw.planFilePath : "",
    reportFilePath: typeof raw.reportFilePath === "string" ? raw.reportFilePath : undefined,
    workCycleId: typeof raw.workCycleId === "string" ? raw.workCycleId : undefined,
    workspace: normalizeWorkspaceRef(raw.workspace),
  };
}

function normalizeWorkspaceRef(value: unknown): DiscoveryPlanWorkspaceRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const strategy = obj.strategy;
  if (strategy !== "git-worktree" && strategy !== "snapshot-copy") return undefined;
  if (typeof obj.cwd !== "string") return undefined;
  return {
    strategy,
    handle: typeof obj.handle === "string" ? obj.handle : "",
    cwd: obj.cwd,
  };
}

function cloneIndex(index: DiscoveryPlanIndex): DiscoveryPlanIndex {
  return { schemaVersion: 1, plans: index.plans.map((entry) => ({ ...entry })) };
}

function toRelativePaths(record: DiscoveryPlanRecord, paths: AlwaysOnPaths): DiscoveryPlanRecord {
  return {
    ...record,
    planFilePath: relativeIfInsideRoot(record.planFilePath, paths.projectDir),
    reportFilePath: record.reportFilePath
      ? relativeIfInsideRoot(record.reportFilePath, paths.projectDir)
      : undefined,
  };
}

function relativeIfInsideRoot(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || rel === "") {
    return filePath;
  }
  return rel;
}

function freezeRecord(record: DiscoveryPlanRecord): DiscoveryPlanRecord {
  return { ...record };
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
