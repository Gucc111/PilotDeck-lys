import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  DiscoveryPlanIndex,
  WorkCycleIndex,
  WorkCycleExecutionRecord,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
} from "../../protocol/types.js";
import type { AlwaysOnPaths } from "../AlwaysOnPaths.js";
import { atomicWriteJson, readJsonSafe } from "./JsonStoreBase.js";

const DEFAULT_INDEX: WorkCycleIndex = { schemaVersion: 1, cycles: [] };

export class WorkCycleStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async readIndex(): Promise<WorkCycleIndex> {
    return readJsonSafe(
      this.paths.cycleIndexFile,
      () => cloneIndex(DEFAULT_INDEX),
      (parsed) => {
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).schemaVersion === 1 &&
          Array.isArray((parsed as WorkCycleIndex).cycles)
        ) {
          return normalizeIndex(parsed as WorkCycleIndex);
        }
        return undefined;
      },
    );
  }

  async writeIndex(index: WorkCycleIndex): Promise<void> {
    await atomicWriteJson(this.paths.cycleIndexFile, index);
  }

  async getRecord(cycleId: string): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    return index.cycles.find((c) => c.id === cycleId);
  }

  async getActiveCycle(): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    return index.cycles.find((c) => c.status === "active");
  }

  async create(
    handle: WorkspaceHandle,
    runId: string,
    cycleId: string,
    now: Date,
  ): Promise<WorkCycleRecord> {
    const index = await this.readIndex();
    const record: WorkCycleRecord = {
      id: cycleId,
      projectKey: handle.projectKey,
      status: "active",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      planIds: [],
      executions: [],
      createdAt: now.toISOString(),
      createdByRunId: runId,
    };
    index.cycles.push(record);
    await this.writeIndex(index);
    return record;
  }

  async addPlan(cycleId: string, planId: string): Promise<void> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return;
    if (!cycle.planIds.includes(planId)) {
      cycle.planIds.push(planId);
      await this.writeIndex(index);
    }
  }

  /**
   * Lazy migration: if no cycles exist on disk but state.json still has
   * currentWorkspace, create a cycle from the legacy data and associate
   * plans that share the same workspace cwd.
   */
  async migrateFromLegacy(deps: {
    stateStore: { read(now: Date): Promise<{ currentWorkspace?: { runId: string; strategy: "git-worktree" | "snapshot-copy"; cwd: string; metadata: Record<string, string> } }>; setActiveWorkCycleId(cycleId: string, now: Date): Promise<unknown> };
    planStore: { readIndex(): Promise<DiscoveryPlanIndex>; updatePlanFields(planId: string, fields: { workCycleId?: string }): Promise<unknown> };
  }): Promise<WorkCycleRecord | undefined> {
    const existing = await this.readIndex();
    if (existing.cycles.length > 0) return undefined;

    const now = new Date();
    const state = await deps.stateStore.read(now).catch(() => undefined);
    const ws = state?.currentWorkspace;
    if (!ws || !existsSync(ws.cwd)) return undefined;

    const cycleId = randomUUID();
    const handle: WorkspaceHandle = {
      runId: ws.runId,
      projectKey: this.paths.projectKey,
      strategy: ws.strategy,
      cwd: ws.cwd,
      metadata: { ...ws.metadata },
    };

    let planIds: string[] = [];
    try {
      const planIndex = await deps.planStore.readIndex();
      planIds = planIndex.plans
        .filter((p) => p.workspace?.cwd === ws.cwd)
        .map((p) => p.id);
    } catch {
      // no plans or unreadable — fine
    }

    const record: WorkCycleRecord = {
      id: cycleId,
      projectKey: this.paths.projectKey,
      status: "active",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      planIds,
      executions: [],
      createdAt: now.toISOString(),
      createdByRunId: ws.runId,
    };
    existing.cycles.push(record);
    await this.writeIndex(existing);

    try {
      await deps.stateStore.setActiveWorkCycleId(cycleId, now);
    } catch {
      // best effort
    }

    for (const planId of planIds) {
      try {
        await deps.planStore.updatePlanFields(planId, { workCycleId: cycleId });
      } catch {
        // best effort
      }
    }

    return record;
  }

  async findExecutionByPlanId(planId: string): Promise<WorkCycleExecutionRecord | undefined> {
    const index = await this.readIndex();
    for (const cycle of index.cycles) {
      const execution = cycle.executions?.find((entry) => entry.planId === planId);
      if (execution) return cloneExecution(execution);
    }
    return undefined;
  }

  async recordExecution(
    cycleId: string,
    execution: WorkCycleExecutionRecord,
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;
    cycle.executions = cycle.executions ?? [];
    if (cycle.executions.some((entry) => entry.planId === execution.planId)) {
      throw new Error(`Plan ${execution.planId} already has an execution record.`);
    }
    cycle.executions.push(cloneExecution(execution));
    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  async updateExecutionDependencies(
    cycleId: string,
    executionId: string,
    update: Pick<WorkCycleExecutionRecord, "dependsOnPlanIds" | "dependencyReasons" | "dependencyAnalysisStatus">,
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    const execution = cycle?.executions?.find((entry) => entry.executionId === executionId);
    if (!cycle || !execution) return undefined;
    execution.dependsOnPlanIds = [...update.dependsOnPlanIds];
    execution.dependencyReasons = [...update.dependencyReasons];
    execution.dependencyAnalysisStatus = update.dependencyAnalysisStatus;
    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  async updateStatus(
    cycleId: string,
    status: WorkCycleStatus,
    now: Date,
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;
    cycle.status = status;
    if (status === "applied") cycle.appliedAt = now.toISOString();
    if (status === "archived") cycle.archivedAt = now.toISOString();
    await this.writeIndex(index);
    return cycle;
  }
}

function cloneIndex(index: WorkCycleIndex): WorkCycleIndex {
  return {
    schemaVersion: 1,
    cycles: index.cycles.map(cloneCycle),
  };
}

function normalizeIndex(index: WorkCycleIndex): WorkCycleIndex {
  return {
    schemaVersion: 1,
    cycles: Array.isArray(index.cycles) ? index.cycles.map(normalizeCycle) : [],
  };
}

function normalizeCycle(raw: Record<string, unknown>): WorkCycleRecord {
  const ws = raw.workspace as Record<string, unknown> | undefined;
  const rawMeta = ws?.metadata;
  const metadata: Record<string, string> = {};
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    for (const [k, v] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (typeof v === "string") metadata[k] = v;
    }
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    projectKey: typeof raw.projectKey === "string" ? raw.projectKey : "",
    status: normalizeStatus(raw.status),
    workspace: {
      strategy: ws?.strategy === "git-worktree" || ws?.strategy === "snapshot-copy" ? ws.strategy : "git-worktree",
      cwd: typeof ws?.cwd === "string" ? ws.cwd : "",
      metadata,
    },
    planIds: safeStringArray(raw.planIds),
    executions: Array.isArray(raw.executions)
      ? (raw.executions as unknown[]).map(normalizeExecution)
      : [],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    createdByRunId: typeof raw.createdByRunId === "string" ? raw.createdByRunId : "",
    appliedAt: typeof raw.appliedAt === "string" ? raw.appliedAt : undefined,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
  };
}

function normalizeExecution(raw: unknown): WorkCycleExecutionRecord {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    executionId: typeof obj.executionId === "string" ? obj.executionId : "",
    runId: typeof obj.runId === "string" ? obj.runId : "",
    planId: typeof obj.planId === "string" ? obj.planId : "",
    status: obj.status === "completed" || obj.status === "failed" ? obj.status : "failed",
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
    finishedAt: typeof obj.finishedAt === "string" ? obj.finishedAt : "",
    baseCommit: typeof obj.baseCommit === "string" ? obj.baseCommit : "",
    beforeHead: typeof obj.beforeHead === "string" ? obj.beforeHead : "",
    afterHead: typeof obj.afterHead === "string" ? obj.afterHead : "",
    commitShas: safeStringArray(obj.commitShas),
    dependsOnPlanIds: safeStringArray(obj.dependsOnPlanIds),
    dependencyReasons: safeStringArray(obj.dependencyReasons),
    dependencyAnalysisStatus:
      obj.dependencyAnalysisStatus === "clean" ||
      obj.dependencyAnalysisStatus === "dependent" ||
      obj.dependencyAnalysisStatus === "failed"
        ? obj.dependencyAnalysisStatus
        : "clean",
  };
}

const VALID_CYCLE_STATUSES = new Set<string>(["active", "applying", "applied", "archived"]);

function normalizeStatus(value: unknown): WorkCycleStatus {
  return typeof value === "string" && VALID_CYCLE_STATUSES.has(value) ? (value as WorkCycleStatus) : "active";
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function cloneCycle(cycle: WorkCycleRecord): WorkCycleRecord {
  return {
    ...cycle,
    workspace: {
      ...cycle.workspace,
      metadata: { ...cycle.workspace.metadata },
    },
    planIds: [...cycle.planIds],
    executions: (cycle.executions ?? []).map(cloneExecution),
  };
}

function cloneExecution(execution: WorkCycleExecutionRecord): WorkCycleExecutionRecord {
  return {
    ...execution,
    commitShas: [...execution.commitShas],
    dependsOnPlanIds: [...execution.dependsOnPlanIds],
    dependencyReasons: [...execution.dependencyReasons],
  };
}
