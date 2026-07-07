import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  CyclePlanState,
  DiscoveryPlanIndex,
  DiscoveryPlanStatus,
  WorkCycleDependencyAnalysisStatus,
  WorkCycleExecutionRecord,
  WorkCycleIndex,
  WorkCyclePlanAttempt,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
} from "../types.js";
import type { AlwaysOnPaths } from "../AlwaysOnPaths.js";
import { atomicWriteJson, readJsonSafe } from "./JsonStoreBase.js";

const DEFAULT_INDEX: WorkCycleIndex = { schemaVersion: 2, cycles: [] };

export type RecordPlanRunInput = {
  planId: string;
  status: "completed" | "failed";
  runId: string;
  startedAt: string;
  finishedAt: string;
  beforeHead: string;
  afterHead: string;
  commitShas: string[];
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: WorkCycleDependencyAnalysisStatus;
  error?: { code: string; message: string };
};

export type BeginApplyInput = {
  token: string;
  planIds: string[];
  now: Date;
};

export class WorkCycleStore {
  private static readonly mutationChains = new Map<string, Promise<unknown>>();

  constructor(private readonly paths: AlwaysOnPaths) {}

  async readIndex(): Promise<WorkCycleIndex> {
    return readJsonSafe(
      this.paths.cycleIndexFile,
      () => cloneIndex(DEFAULT_INDEX),
      (parsed) => {
        if (!parsed || typeof parsed !== "object") return undefined;
        const obj = parsed as Record<string, unknown>;
        if (!Array.isArray(obj.cycles)) return undefined;
        if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) return undefined;
        return normalizeIndex(obj);
      },
    );
  }

  async writeIndex(index: WorkCycleIndex): Promise<void> {
    await atomicWriteJson(this.paths.cycleIndexFile, normalizeIndex(index));
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
      baseCommit: handle.metadata.baseCommit ?? "",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      plans: {},
      createdAt: now.toISOString(),
      createdByRunId: runId,
    };
    index.cycles.push(record);
    await this.writeIndex(index);
    return cloneCycle(record);
  }

  async addPlan(cycleId: string, planId: string, now = new Date()): Promise<void> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return;
    ensurePlanState(cycle, planId, now, cycle.plans[planId]?.status ?? "ready");
    await this.writeIndex(index);
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
      // no plans or unreadable is fine
    }

    const record: WorkCycleRecord = {
      id: cycleId,
      projectKey: this.paths.projectKey,
      status: "active",
      baseCommit: handle.metadata.baseCommit ?? "",
      workspace: {
        strategy: handle.strategy,
        cwd: handle.cwd,
        metadata: { ...handle.metadata },
      },
      plans: Object.fromEntries(
        planIds.map((planId) => [
          planId,
          createEmptyPlanState(now.toISOString(), "ready"),
        ]),
      ),
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

    return cloneCycle(record);
  }

  async getPlanState(planId: string): Promise<CyclePlanState | undefined> {
    const index = await this.readIndex();
    for (const cycle of index.cycles) {
      const state = cycle.plans[planId];
      if (state) return clonePlanState(state);
    }
    return undefined;
  }

  async updatePlanStatus(
    cycleId: string,
    planId: string,
    status: DiscoveryPlanStatus,
    now = new Date(),
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;
    const state = ensurePlanState(cycle, planId, now, status);
    state.status = status;
    state.updatedAt = now.toISOString();
    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  async updatePlanDependencies(
    cycleId: string,
    planId: string,
    update: Pick<CyclePlanState, "dependsOnPlanIds" | "dependencyReasons" | "dependencyAnalysisStatus">,
    now = new Date(),
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;
    const state = ensurePlanState(cycle, planId, now, cycle.plans[planId]?.status ?? "ready");
    state.dependsOnPlanIds = [...update.dependsOnPlanIds];
    state.dependencyReasons = [...update.dependencyReasons];
    state.dependencyAnalysisStatus = update.dependencyAnalysisStatus;
    state.updatedAt = now.toISOString();
    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  async recordPlanRun(
    cycleId: string,
    input: RecordPlanRunInput,
  ): Promise<WorkCycleRecord | undefined> {
    const index = await this.readIndex();
    const cycle = index.cycles.find((c) => c.id === cycleId);
    if (!cycle) return undefined;

    const finishedAt = input.finishedAt || new Date().toISOString();
    const planStatus: DiscoveryPlanStatus = input.status === "completed" ? "completed" : "failed";
    const state = ensurePlanState(cycle, input.planId, new Date(finishedAt), planStatus);
    const appended = appendUnique(state.commitShas, input.commitShas);
    state.status = planStatus;
    state.beforeHead = input.beforeHead || state.beforeHead;
    state.afterHead = input.afterHead || state.afterHead;
    state.commitShas = appended;
    state.dependsOnPlanIds = [...input.dependsOnPlanIds];
    state.dependencyReasons = [...input.dependencyReasons];
    state.dependencyAnalysisStatus = input.dependencyAnalysisStatus;
    state.lastRunId = input.runId;
    state.updatedAt = finishedAt;
    const attempt: WorkCyclePlanAttempt = {
      runId: input.runId,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt,
      beforeHead: input.beforeHead,
      afterHead: input.afterHead,
      commitShas: [...input.commitShas],
      error: input.error ? { ...input.error } : undefined,
    };
    state.attempts = [...(state.attempts ?? []), attempt];

    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  async beginApply(
    cycleId: string,
    input: BeginApplyInput,
  ): Promise<WorkCycleRecord> {
    return this.withCycleMutation(cycleId, async () => {
      const index = await this.readIndex();
      const cycle = index.cycles.find((c) => c.id === cycleId);
      if (!cycle) {
        throw makeStoreError("Work cycle not found", "NOT_FOUND");
      }
      if (cycle.status === "applying") {
        throw makeStoreError("This work cycle is already being applied.", "APPLY_IN_PROGRESS");
      }
      if (cycle.status !== "active") {
        throw makeStoreError(
          `Cycle must be active to apply (current: ${cycle.status})`,
          "INVALID_STATE",
        );
      }
      cycle.status = "applying";
      cycle.applyLock = {
        token: input.token,
        planIds: [...input.planIds],
        startedAt: input.now.toISOString(),
      };
      await this.writeIndex(index);
      return cloneCycle(cycle);
    });
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
    if (status !== "applying") {
      delete cycle.applyLock;
    }
    if (status === "applied") cycle.appliedAt = now.toISOString();
    if (status === "archived") cycle.archivedAt = now.toISOString();
    await this.writeIndex(index);
    return cloneCycle(cycle);
  }

  private async withCycleMutation<T>(cycleId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.paths.cycleIndexFile}:${cycleId}`;
    const previous = WorkCycleStore.mutationChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current, () => current);
    WorkCycleStore.mutationChains.set(key, chain);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (WorkCycleStore.mutationChains.get(key) === chain) {
        WorkCycleStore.mutationChains.delete(key);
      }
    }
  }
}

function normalizeIndex(index: Record<string, unknown>): WorkCycleIndex {
  return {
    schemaVersion: 2,
    cycles: Array.isArray(index.cycles)
      ? index.cycles.map((cycle) => normalizeCycle(cycle as Record<string, unknown>))
      : [],
  };
}

function normalizeCycle(raw: Record<string, unknown>): WorkCycleRecord {
  const ws = raw.workspace as Record<string, unknown> | undefined;
  const metadata = normalizeMetadata(ws?.metadata);
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const baseCommit =
    typeof raw.baseCommit === "string"
      ? raw.baseCommit
      : typeof metadata.baseCommit === "string"
        ? metadata.baseCommit
        : legacyExecutionBaseCommit(raw);
  const plans = normalizePlans(raw, createdAt);
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    projectKey: typeof raw.projectKey === "string" ? raw.projectKey : "",
    status: normalizeStatus(raw.status),
    baseCommit,
    workspace: {
      strategy: ws?.strategy === "git-worktree" || ws?.strategy === "snapshot-copy" ? ws.strategy : "git-worktree",
      cwd: typeof ws?.cwd === "string" ? ws.cwd : "",
      metadata,
    },
    plans,
    createdAt,
    createdByRunId: typeof raw.createdByRunId === "string" ? raw.createdByRunId : "",
    applyLock: normalizeApplyLock(raw.applyLock),
    appliedAt: typeof raw.appliedAt === "string" ? raw.appliedAt : undefined,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
  };
}

function normalizeApplyLock(raw: unknown): WorkCycleRecord["applyLock"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token : "";
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : "";
  if (!token || !startedAt) return undefined;
  return {
    token,
    startedAt,
    planIds: safeStringArray(obj.planIds),
  };
}

function normalizePlans(raw: Record<string, unknown>, fallbackUpdatedAt: string): Record<string, CyclePlanState> {
  const out: Record<string, CyclePlanState> = {};
  const rawPlans = raw.plans;
  if (rawPlans && typeof rawPlans === "object" && !Array.isArray(rawPlans)) {
    for (const [planId, value] of Object.entries(rawPlans as Record<string, unknown>)) {
      out[planId] = normalizePlanState(value, fallbackUpdatedAt);
    }
  }

  for (const planId of safeStringArray(raw.planIds)) {
    out[planId] = out[planId] ?? createEmptyPlanState(fallbackUpdatedAt, "ready");
  }

  if (Array.isArray(raw.executions)) {
    for (const execution of (raw.executions as unknown[]).map(normalizeExecution)) {
      if (!execution.planId) continue;
      const existing = out[execution.planId] ?? createEmptyPlanState(execution.finishedAt || fallbackUpdatedAt, "ready");
      const attempt: WorkCyclePlanAttempt = {
        runId: execution.runId,
        status: execution.status,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        beforeHead: execution.beforeHead,
        afterHead: execution.afterHead,
        commitShas: [...execution.commitShas],
      };
      out[execution.planId] = {
        ...existing,
        status: execution.status === "completed" ? "completed" : "failed",
        commitShas: appendUnique(existing.commitShas, execution.commitShas),
        beforeHead: execution.beforeHead || existing.beforeHead,
        afterHead: execution.afterHead || existing.afterHead,
        dependsOnPlanIds: [...execution.dependsOnPlanIds],
        dependencyReasons: [...execution.dependencyReasons],
        dependencyAnalysisStatus: execution.dependencyAnalysisStatus,
        lastRunId: execution.runId || existing.lastRunId,
        updatedAt: execution.finishedAt || existing.updatedAt,
        attempts: [...(existing.attempts ?? []), attempt],
      };
    }
  }

  return out;
}

function normalizePlanState(raw: unknown, fallbackUpdatedAt: string): CyclePlanState {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    status: normalizePlanStatus(obj.status),
    commitShas: safeStringArray(obj.commitShas),
    beforeHead: typeof obj.beforeHead === "string" ? obj.beforeHead : undefined,
    afterHead: typeof obj.afterHead === "string" ? obj.afterHead : undefined,
    dependsOnPlanIds: safeStringArray(obj.dependsOnPlanIds),
    dependencyReasons: safeStringArray(obj.dependencyReasons),
    dependencyAnalysisStatus: normalizeDependencyStatus(obj.dependencyAnalysisStatus),
    lastRunId: typeof obj.lastRunId === "string" ? obj.lastRunId : undefined,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : fallbackUpdatedAt,
    attempts: Array.isArray(obj.attempts)
      ? obj.attempts.map(normalizeAttempt)
      : undefined,
  };
}

function normalizeAttempt(raw: unknown): WorkCyclePlanAttempt {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const error = obj.error && typeof obj.error === "object"
    ? obj.error as Record<string, unknown>
    : undefined;
  return {
    runId: typeof obj.runId === "string" ? obj.runId : "",
    status: obj.status === "completed" ? "completed" : "failed",
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
    finishedAt: typeof obj.finishedAt === "string" ? obj.finishedAt : "",
    beforeHead: typeof obj.beforeHead === "string" ? obj.beforeHead : "",
    afterHead: typeof obj.afterHead === "string" ? obj.afterHead : "",
    commitShas: safeStringArray(obj.commitShas),
    error: error
      ? {
          code: typeof error.code === "string" ? error.code : "unknown",
          message: typeof error.message === "string" ? error.message : "",
        }
      : undefined,
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
    dependencyAnalysisStatus: normalizeDependencyStatus(obj.dependencyAnalysisStatus),
  };
}

function createEmptyPlanState(updatedAt: string, status: DiscoveryPlanStatus): CyclePlanState {
  return {
    status,
    commitShas: [],
    dependsOnPlanIds: [],
    dependencyReasons: [],
    dependencyAnalysisStatus: "clean",
    updatedAt,
  };
}

function ensurePlanState(
  cycle: WorkCycleRecord,
  planId: string,
  now: Date,
  status: DiscoveryPlanStatus,
): CyclePlanState {
  cycle.plans[planId] = cycle.plans[planId] ?? createEmptyPlanState(now.toISOString(), status);
  return cycle.plans[planId];
}

function legacyExecutionBaseCommit(raw: Record<string, unknown>): string {
  if (!Array.isArray(raw.executions)) return "";
  for (const execution of raw.executions) {
    const obj = execution && typeof execution === "object" ? execution as Record<string, unknown> : undefined;
    if (typeof obj?.baseCommit === "string") return obj.baseCommit;
  }
  return "";
}

function normalizeMetadata(rawMeta: unknown): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    for (const [k, v] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (typeof v === "string") metadata[k] = v;
    }
  }
  return metadata;
}

const VALID_CYCLE_STATUSES = new Set<string>(["active", "applying", "applied", "archived"]);
const VALID_PLAN_STATUSES = new Set<string>([
  "ready",
  "executing",
  "completed",
  "completed_no_report",
  "failed",
  "applied",
  "archived",
]);

function normalizeStatus(value: unknown): WorkCycleStatus {
  return typeof value === "string" && VALID_CYCLE_STATUSES.has(value) ? (value as WorkCycleStatus) : "active";
}

function normalizePlanStatus(value: unknown): DiscoveryPlanStatus {
  return typeof value === "string" && VALID_PLAN_STATUSES.has(value)
    ? (value as DiscoveryPlanStatus)
    : "ready";
}

function normalizeDependencyStatus(value: unknown): WorkCycleDependencyAnalysisStatus {
  return value === "clean" || value === "dependent" || value === "failed" ? value : "clean";
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function appendUnique(existing: string[], next: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const item of next) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function cloneIndex(index: WorkCycleIndex): WorkCycleIndex {
  return {
    schemaVersion: 2,
    cycles: index.cycles.map(cloneCycle),
  };
}

function cloneCycle(cycle: WorkCycleRecord): WorkCycleRecord {
  return {
    ...cycle,
    workspace: {
      ...cycle.workspace,
      metadata: { ...cycle.workspace.metadata },
    },
    applyLock: cycle.applyLock
      ? {
          token: cycle.applyLock.token,
          startedAt: cycle.applyLock.startedAt,
          planIds: [...cycle.applyLock.planIds],
        }
      : undefined,
    plans: Object.fromEntries(
      Object.entries(cycle.plans).map(([planId, state]) => [planId, clonePlanState(state)]),
    ),
  };
}

function clonePlanState(state: CyclePlanState): CyclePlanState {
  return {
    ...state,
    commitShas: [...state.commitShas],
    dependsOnPlanIds: [...state.dependsOnPlanIds],
    dependencyReasons: [...state.dependencyReasons],
    attempts: state.attempts?.map((attempt) => ({
      ...attempt,
      commitShas: [...attempt.commitShas],
      error: attempt.error ? { ...attempt.error } : undefined,
    })),
  };
}

function makeStoreError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
