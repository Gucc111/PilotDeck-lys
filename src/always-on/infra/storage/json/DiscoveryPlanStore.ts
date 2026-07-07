import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DiscoveryPlanIndex, DiscoveryPlanRecord, DiscoveryPlanStatus, DiscoveryPlanWorkspaceRef } from "../types.js";
import { planMarkdownPath, type AlwaysOnPaths } from "../AlwaysOnPaths.js";
import { atomicWriteJson, readJsonSafe } from "./JsonStoreBase.js";

const DEFAULT_INDEX: DiscoveryPlanIndex = { schemaVersion: 1, plans: [] };

const VALID_PLAN_STATUSES = new Set<string>([
  "ready", "executing", "completed", "completed_no_report", "failed", "applied", "archived",
]);

export type LegacyPlanStatusSnapshot = {
  planId: string;
  status: DiscoveryPlanStatus;
  workCycleId?: string;
  createdAt: string;
};

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

  async writePlanMarkdown(title: string, uid: string, markdown: string): Promise<string> {
    const filePath = planMarkdownPath(this.paths, title, uid);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
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

  async getRecord(planId: string): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    return index.plans.find((entry) => entry.id === planId);
  }

  async updatePlanFields(
    planId: string,
    fields: Partial<Pick<DiscoveryPlanRecord, "reportFilePath" | "workCycleId" | "title" | "summary" | "rationale">>,
  ): Promise<DiscoveryPlanRecord | undefined> {
    const index = await this.readIndex();
    const target = index.plans.find((entry) => entry.id === planId);
    if (!target) return undefined;
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
    await this.writeIndex(index);
    return target;
  }

  async consumeLegacyStatuses(): Promise<LegacyPlanStatusSnapshot[]> {
    const parsed = await readJsonSafe(
      this.paths.planIndexFile,
      () => undefined as Record<string, unknown> | undefined,
      (value) => (
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).schemaVersion === 1 &&
        Array.isArray((value as Record<string, unknown>).plans)
          ? value as Record<string, unknown>
          : undefined
      ),
    );
    if (!parsed) return [];
    const rawPlans = parsed.plans as unknown[];
    const legacy: LegacyPlanStatusSnapshot[] = [];
    for (const raw of rawPlans) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.id !== "string") continue;
      if (!VALID_PLAN_STATUSES.has(obj.status as string)) continue;
      legacy.push({
        planId: obj.id,
        status: obj.status as DiscoveryPlanStatus,
        workCycleId: typeof obj.workCycleId === "string" ? obj.workCycleId : undefined,
        createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString(),
      });
    }
    if (legacy.length === 0) return [];
    await this.writeIndex(normalizeIndex(parsed as unknown as DiscoveryPlanIndex));
    return legacy;
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
    summary: typeof raw.summary === "string" ? raw.summary : "",
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
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
