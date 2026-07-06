/**
 * Discovery plan lifecycle service.
 *
 * Owns:
 *   - plan overview building + normalization (DiscoveryPlanRecord → WebPlanRecord)
 *   - queue / update / archive business logic (with guards)
 *   - preference event emission
 *
 * All data access is delegated to Runtime Store instances supplied via `createStores`.
 */

import { randomUUID } from "node:crypto";
import type {
  CyclePlanState,
  DiscoveryPlanIndex,
  DiscoveryPlanRecord,
  DiscoveryPlanStatus,
  WorkCycleIndex,
  WorkCycleRecord,
  WorkCycleStatus,
  PreferenceEvent,
} from "../infra/storage/types.js";
import type { PreferenceEventStore } from "../infra/storage/log/PreferenceEventStore.js";
import type { DiscoveryPlanStore } from "../infra/storage/json/DiscoveryPlanStore.js";
import type { WorkCycleStore } from "../infra/storage/json/WorkCycleStore.js";
import type { DiscoveryStateStore } from "../infra/storage/json/DiscoveryStateStore.js";
import type { DiscoveryReportStore } from "../infra/storage/file/DiscoveryReportStore.js";
import {
  checkApplyProjectReadiness,
  generateApplyChangedFileList,
  type ApplyProjectReadiness,
} from "../infra/git/index.js";
import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  sortDiscoveryPlans,
  toIsoTimestamp,
  type WebPlanContextRefs,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

export {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRUCTURE_VERSION = 1;

// ---------------------------------------------------------------------------
// Dependencies — callers inject these so the service stays testable
// ---------------------------------------------------------------------------

export type ProjectPathResolver = {
  extractProjectDirectory(projectName: string): Promise<string>;
};

export type SessionActivityChecker = {
  isSessionActive(sessionId: string): boolean;
};

export type SessionLister = {
  getSessions(
    projectName: string,
    limit: number,
    offset: number,
  ): Promise<{ sessions: Array<Record<string, unknown>> }>;
};

export type PlanLifecycleActions = {
  getCycleWorkspaceStatus?(input: { workspaceCwd: string }): Promise<string>;
  archivePlanCommits?(input: {
    workspaceCwd: string;
    commitShas: string[];
  }): Promise<{ archived: boolean; error?: string }>;
  disposeCycleWorkspace(input: {
    strategy: string;
    cwd: string;
    projectRoot: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
};

export type StateManager = {
  clearActiveWorkCycleId(projectRoot: string): Promise<void>;
};

export type ProjectStores = {
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  stateStore: DiscoveryStateStore;
  reportStore: DiscoveryReportStore;
};

export type DiscoveryPlanServiceDeps = {
  createStores: (projectRoot: string) => ProjectStores;
  paths: ProjectPathResolver;
  sessions: SessionLister;
  activity: SessionActivityChecker;
  planLifecycle?: PlanLifecycleActions;
  state?: StateManager;
  preferenceEvents?: {
    forProject: (projectRoot: string) => PreferenceEventStore;
  };
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
};

export type QueueCycleApplyOptions = {
  allowDivergedProject?: boolean;
};

// ---------------------------------------------------------------------------
// Normalization (DiscoveryPlanRecord → WebPlanRecord)
// ---------------------------------------------------------------------------

function createEmptyContextRefs(): WebPlanContextRefs {
  return {
    workingDirectory: [],
    memory: [],
    existingPlans: [],
    cronJobs: [],
    recentChats: [],
  };
}

function relativePlanPath(planId: string): string {
  return `plans/${planId}.md`;
}

export function normalizeDiscoveryPlanRecord(record: Record<string, unknown> | null | undefined): WebPlanRecord {
  const now = new Date().toISOString();
  const rawContextRefs =
    record?.contextRefs && typeof record.contextRefs === "object" && !Array.isArray(record.contextRefs)
      ? (record.contextRefs as Record<string, unknown>)
      : null;
  const contextRefs: WebPlanContextRefs = rawContextRefs
    ? {
        workingDirectory: normalizeStringList(rawContextRefs.workingDirectory),
        memory: normalizeStringList(rawContextRefs.memory),
        existingPlans: normalizeStringList(rawContextRefs.existingPlans),
        cronJobs: normalizeStringList(rawContextRefs.cronJobs),
        recentChats: normalizeStringList(rawContextRefs.recentChats),
      }
    : createEmptyContextRefs();

  const fallbackId = `plan-${randomUUID().slice(0, 8)}`;
  const id = normalizeString(record?.id, fallbackId);
  const sourceId = normalizeString(
    (record?.sourceDiscoverySessionId as string) || (record?.sourceRunId as string),
  );
  const gatewayStatus = normalizeString(record?.status, "ready");
  const mappedStatus =
    gatewayStatus === "executing" ? "running" :
    gatewayStatus === "superseded" ? "archived" :
    gatewayStatus === "applying" ? "completed" :
    gatewayStatus === "apply_failed" ? "completed" :
    gatewayStatus;

  return {
    id,
    title: normalizeString(record?.title, "Untitled discovery plan"),
    createdAt: toIsoTimestamp(record?.createdAt as string) || now,
    updatedAt: toIsoTimestamp((record?.updatedAt as string) || (record?.createdAt as string)) || now,
    status: mappedStatus,
    summary: normalizeString(record?.summary),
    rationale: normalizeString(record?.rationale),
    sourceDiscoverySessionId: sourceId,
    executionSessionId: normalizeString(record?.executionSessionId),
    executionStartedAt: toIsoTimestamp(record?.executionStartedAt as string),
    executionLastActivityAt: toIsoTimestamp(record?.executionLastActivityAt as string),
    executionStatus: normalizeString(record?.executionStatus),
    latestSummary: normalizeString(record?.latestSummary),
    contextRefs,
    planFilePath: normalizeString(record?.planFilePath, relativePlanPath(id)),
    reportFilePath: normalizeString(record?.reportFilePath) || undefined,
    structureVersion:
      typeof record?.structureVersion === "number" ? record.structureVersion : STRUCTURE_VERSION,
    workCycleId: normalizeString(record?.workCycleId) || undefined,
    executionCommitShas: normalizeStringList(record?.executionCommitShas),
    dependsOnPlanIds: normalizeStringList(record?.dependsOnPlanIds),
    dependencyReasons: normalizeStringList(record?.dependencyReasons),
    dependencyAnalysisStatus: normalizeString(record?.dependencyAnalysisStatus) || undefined,
    workspace: normalizeWorkspaceRef(record?.workspace),
  };
}

function normalizeWorkspaceRef(
  raw: unknown,
): { strategy: string; cwd: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const strategy = typeof obj.strategy === "string" ? obj.strategy : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
  if (!strategy || !cwd) return undefined;
  return { strategy, cwd };
}

function toWebPlanRecords(index: DiscoveryPlanIndex): WebPlanRecord[] {
  return index.plans.map((plan) =>
    normalizeDiscoveryPlanRecord(plan as unknown as Record<string, unknown>),
  );
}

// ---------------------------------------------------------------------------
// Overview building
// ---------------------------------------------------------------------------

function buildOverview(
  plan: WebPlanRecord,
  content: string,
  session: WebPlanSession,
  isSessionActive: (id: string) => boolean,
) {
  const status = computePlanStatus(plan, session, isSessionActive);
  const latestSummary = normalizeString(
    session?.lastAssistantMessage || session?.summary || session?.title || plan.latestSummary,
  );
  return {
    ...plan,
    status,
    executionStatus: computeExecutionStatus(plan, session, isSessionActive) || undefined,
    executionStartedAt:
      pickLatestIsoTimestamp(plan.executionStartedAt, session?.createdAt, session?.created_at) || undefined,
    executionLastActivityAt:
      pickLatestIsoTimestamp(plan.executionLastActivityAt, session?.lastActivity, session?.updated_at) || undefined,
    latestSummary: latestSummary || undefined,
    workspace: plan.workspace,
    content: content.trim(),
  };
}

function isResolvedPlan(plan: WebPlanRecord): boolean {
  return plan.status === "applied" || plan.status === "archived";
}

function normalizePlanSelection(
  cycle: { plans: Record<string, CyclePlanState> },
  plans: WebPlanRecord[],
  planIds?: string[],
): string[] {
  const cyclePlanIds = new Set(Object.keys(cycle.plans));
  if (planIds === undefined) {
    return plans
      .filter((plan) => cyclePlanIds.has(plan.id) && !isResolvedPlan(plan))
      .map((plan) => plan.id);
  }
  const selected = new Set<string>();
  for (const id of planIds) {
    const normalized = normalizeString(id);
    if (normalized) selected.add(normalized);
  }
  return [...selected];
}

function validateApplySelection(
  cycle: { plans: Record<string, CyclePlanState> },
  plans: WebPlanRecord[],
  selectedPlanIds: string[],
): void {
  if (selectedPlanIds.length === 0) {
    throw makeError("Select at least one plan to apply", "INVALID_SELECTION");
  }

  const cyclePlanIds = new Set(Object.keys(cycle.plans));
  const activePlans = plans.filter((plan) => cyclePlanIds.has(plan.id) && !isResolvedPlan(plan));
  const planById = new Map(activePlans.map((plan) => [plan.id, plan]));
  for (const planId of selectedPlanIds) {
    const plan = planById.get(planId);
    if (!plan) {
      throw makeError(`Plan ${planId} is not an active plan in this cycle`, "INVALID_SELECTION");
    }
    if (plan.status !== "completed" && plan.status !== "completed_no_report") {
      throw makeError(`Plan ${planId} must be completed before it can be applied`, "INVALID_SELECTION");
    }
  }

  const cyclePlanEntries = Object.entries(cycle.plans);
  if (cyclePlanEntries.some(([, state]) => state.dependencyAnalysisStatus === "failed")) {
    throw makeError(
      "Cycle contains a plan whose dependency analysis failed; discard the entire cycle instead.",
      "INVALID_SELECTION",
    );
  }

  const selected = new Set(selectedPlanIds);
  for (const planId of selectedPlanIds) {
    const state = cycle.plans[planId];
    if (!state || (state.status !== "completed" && state.status !== "completed_no_report")) {
      throw makeError(`Plan ${planId} has no successful execution to apply`, "INVALID_SELECTION");
    }
    if (state.commitShas.length === 0) {
      throw makeError(`Plan ${planId} has no commits to apply`, "INVALID_SELECTION");
    }
    const missing = state.dependsOnPlanIds.filter((dependencyId) => !selected.has(dependencyId));
    if (missing.length > 0) {
      throw makeError(
        `Plan ${planId} depends on unselected plan(s): ${missing.join(", ")}`,
        "INVALID_SELECTION",
      );
    }
  }
}

function validateArchiveSelection(
  cycle: { plans: Record<string, CyclePlanState> },
  plans: WebPlanRecord[],
  selectedPlanIds: string[],
): { archiveWholeCycle: boolean } {
  if (selectedPlanIds.length === 0) {
    throw makeError("Select at least one plan to archive", "INVALID_SELECTION");
  }

  const cyclePlanIds = new Set(Object.keys(cycle.plans));
  const activePlans = plans.filter((plan) => cyclePlanIds.has(plan.id) && !isResolvedPlan(plan));
  const activeIds = new Set(activePlans.map((plan) => plan.id));
  for (const planId of selectedPlanIds) {
    if (!activeIds.has(planId)) {
      throw makeError(`Plan ${planId} is not an active plan in this cycle`, "INVALID_SELECTION");
    }
  }

  const selected = new Set(selectedPlanIds);
  const archiveWholeCycle = activePlans.every((plan) => selected.has(plan.id));
  if (archiveWholeCycle) return { archiveWholeCycle: true };

  if (Object.values(cycle.plans).some((state) => state.dependencyAnalysisStatus === "failed")) {
    throw makeError(
      "Cycle contains a plan whose dependency analysis failed; only whole-cycle archive is allowed.",
      "INVALID_SELECTION",
    );
  }

  for (const plan of activePlans) {
    if (selected.has(plan.id)) continue;
    const state = cycle.plans[plan.id];
    const removedDependencies = (state?.dependsOnPlanIds ?? []).filter((dependencyId) => selected.has(dependencyId));
    if (removedDependencies.length > 0) {
      throw makeError(
        `Plan ${plan.id} depends on plan(s) selected for archive: ${removedDependencies.join(", ")}`,
        "INVALID_SELECTION",
      );
    }
  }

  return { archiveWholeCycle: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DiscoveryPlanService {
  private readonly deps: DiscoveryPlanServiceDeps;

  constructor(deps: DiscoveryPlanServiceDeps) {
    this.deps = deps;
  }

  private stores(projectRoot: string): ProjectStores {
    return this.deps.createStores(projectRoot);
  }

  async getPlansOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, cycleStore, reportStore } = this.stores(projectRoot);

    const planIndex = await planStore.readIndex();
    const webPlans = toWebPlanRecords(planIndex);
    if (webPlans.length === 0) return { plans: [] };

    const sessionResult = await this.deps.sessions
      .getSessions(projectName, Number.MAX_SAFE_INTEGER, 0)
      .catch(() => ({ sessions: [] }));
    const sessionsById = new Map<string, Record<string, unknown>>();
    if (Array.isArray(sessionResult?.sessions)) {
      for (const s of sessionResult.sessions) {
        if (s.id) sessionsById.set(s.id as string, s);
      }
    }

    const isActive = (id: string) => this.deps.activity.isSessionActive(id);

    const cycleIndex = await cycleStore.readIndex();
    const cycleWorkspaceMap = new Map(cycleIndex.cycles.map((c) => [c.id, c.workspace]));
    const planStateByPlanId = new Map<string, CyclePlanState>();
    for (const cycle of cycleIndex.cycles) {
      for (const [planId, state] of Object.entries(cycle.plans)) {
        planStateByPlanId.set(planId, state);
      }
    }

    const plans = await Promise.all(
      webPlans.map(async (plan) => {
        const body = await planStore.readPlanByPath(plan.planFilePath) ?? "";
        const session = plan.executionSessionId
          ? (sessionsById.get(plan.executionSessionId) as WebPlanSession) || null
          : null;
        const overview = buildOverview(plan, body, session, isActive);
        if (!overview.workspace && plan.workCycleId) {
          overview.workspace = cycleWorkspaceMap.get(plan.workCycleId) as { strategy: string; cwd: string } | undefined;
        }
        const cyclePlan = planStateByPlanId.get(plan.id);
        if (cyclePlan) {
          overview.executionCommitShas = [...cyclePlan.commitShas];
          overview.dependsOnPlanIds = [...cyclePlan.dependsOnPlanIds];
          overview.dependencyReasons = [...cyclePlan.dependencyReasons];
          overview.dependencyAnalysisStatus = cyclePlan.dependencyAnalysisStatus;
        }
        return overview;
      }),
    );

    return { plans: sortDiscoveryPlans(plans) };
  }

  async archiveCycle(projectName: string, cycleId: string, planIds?: string[]) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, cycleStore } = this.stores(projectRoot);

    const cycleIndex = await cycleStore.readIndex();
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    if (cycle.status === "applying") {
      throw makeError("Cannot archive a cycle that is currently being applied", "INVALID_STATE");
    }

    if (cycle.status !== "active") {
      throw makeError(
        `Cycle must be active to archive plans (current: ${cycle.status})`,
        "INVALID_STATE",
      );
    }

    if (!cycle.workspace?.cwd) {
      throw makeError(
        "Cycle has no associated workspace to archive",
        "MISSING_WORKSPACE",
      );
    }

    const storeIndex = await planStore.readIndex();
    const webPlans = toWebPlanRecords(storeIndex);
    const selectedPlanIds = normalizePlanSelection(cycle, webPlans, planIds);
    const { archiveWholeCycle } = validateArchiveSelection(cycle, webPlans, selectedPlanIds);
    const now = new Date().toISOString();
    const selectedCommitShas = selectedPlanIds.flatMap((id) => cycle.plans[id]?.commitShas ?? []);
    if (!this.deps.planLifecycle?.getCycleWorkspaceStatus || !this.deps.planLifecycle.archivePlanCommits) {
      throw makeError("Archive requires workspace git revert support", "MISSING_WORKSPACE");
    }
    const status = await this.deps.planLifecycle.getCycleWorkspaceStatus({ workspaceCwd: cycle.workspace.cwd });
    if (status.trim()) {
      throw makeError("Cannot archive plans while isolated workspace has uncommitted changes", "WORKSPACE_DIRTY");
    }
    if (selectedCommitShas.length > 0) {
      const archived = await this.deps.planLifecycle.archivePlanCommits({
        workspaceCwd: cycle.workspace.cwd,
        commitShas: selectedCommitShas,
      });
      if (!archived.archived) {
        throw makeError(archived.error || "Failed to revert archived plan commits", "ARCHIVE_REVERT_FAILED");
      }
    }

    await planStore.batchUpdateStatus(
      selectedPlanIds
        .filter((id) => {
          const plan = webPlans.find((p) => p.id === id);
          return plan && !isResolvedPlan(plan);
        })
        .map((id) => ({ planId: id, status: "archived" as DiscoveryPlanStatus, updatedAt: now })),
    );
    for (const planId of selectedPlanIds) {
      await cycleStore.updatePlanStatus(cycleId, planId, "archived", new Date(now));
    }

    const updatedWebPlans = toWebPlanRecords(await planStore.readIndex());
    const hasRemainingPlan = updatedWebPlans.some((plan) => (
      Object.prototype.hasOwnProperty.call(cycle.plans, plan.id) && !isResolvedPlan(plan)
    ));
    const shouldCloseCycle = archiveWholeCycle || !hasRemainingPlan;

    if (shouldCloseCycle && cycle.workspace?.cwd && this.deps.planLifecycle) {
      try {
        await this.deps.planLifecycle.disposeCycleWorkspace({
          strategy: cycle.workspace.strategy,
          cwd: cycle.workspace.cwd,
          projectRoot,
          metadata: cycle.workspace.metadata,
        });
      } catch {
        // Best effort — workspace may already be gone.
      }
    }

    if (shouldCloseCycle) {
      await cycleStore.updateStatus(cycleId, "archived", new Date(now));
    }

    if (shouldCloseCycle && this.deps.state) {
      try {
        await this.deps.state.clearActiveWorkCycleId(projectRoot);
      } catch {
        // Best effort — state cleanup should not block archive.
      }
    }

    await this.appendPreferenceEvent(projectRoot, {
      schemaVersion: 2,
      eventId: randomUUID(),
      timestamp: now,
      action: "archive",
      cycleId,
      plans: webPlans
        .filter((plan) => selectedPlanIds.includes(plan.id))
        .map((plan) => ({
          id: plan.id,
          title: plan.title,
          summary: normalizeString(plan.summary),
          outcome: "archived" as const,
        })),
      indexed: false,
    });

    return { archived: true, planIds: selectedPlanIds };
  }

  async checkApplyReadiness(
    projectName: string,
    cycleId: string,
    planIds?: string[],
  ): Promise<ApplyProjectReadiness> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, cycleStore } = this.stores(projectRoot);

    const cycleIndex = await cycleStore.readIndex();
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    if (cycle.status !== "active") {
      throw makeError(
        `Cycle must be in active status to apply (current: ${cycle.status})`,
        "INVALID_STATE",
      );
    }

    if (!cycle.workspace?.cwd) {
      throw makeError(
        "Cycle has no associated workspace to apply",
        "MISSING_WORKSPACE",
      );
    }

    const storeIndex = await planStore.readIndex();
    const webPlans = toWebPlanRecords(storeIndex);
    const selectedPlanIds = normalizePlanSelection(cycle, webPlans, planIds);
    validateApplySelection(cycle, webPlans, selectedPlanIds);

    return this.computeApplyReadiness(projectRoot, cycle, selectedPlanIds);
  }

  /**
   * Mark a cycle as "applying" and return its metadata.
   */
  async queueCycleApply(
    projectName: string,
    cycleId: string,
    planIds?: string[],
    options: QueueCycleApplyOptions = {},
  ) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, cycleStore } = this.stores(projectRoot);

    const cycleIndex = await cycleStore.readIndex();
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    if (cycle.status !== "active") {
      throw makeError(
        `Cycle must be in active status to apply (current: ${cycle.status})`,
        "INVALID_STATE",
      );
    }

    if (!cycle.workspace?.cwd) {
      throw makeError(
        "Cycle has no associated workspace to apply",
        "MISSING_WORKSPACE",
      );
    }

    const storeIndex = await planStore.readIndex();
    const webPlans = toWebPlanRecords(storeIndex);
    const selectedPlanIds = normalizePlanSelection(cycle, webPlans, planIds);
    validateApplySelection(cycle, webPlans, selectedPlanIds);

    const readiness = await this.computeApplyReadiness(projectRoot, cycle, selectedPlanIds);
    enforceApplyReadiness(readiness, options);

    await cycleStore.updateStatus(cycleId, "applying", new Date());

    const executionToken = randomUUID();

    return {
      cycle,
      projectRoot,
      executionToken,
      planIds: selectedPlanIds,
      readiness,
    };
  }

  /**
   * Finalize a cycle apply — called after the gateway apply RPC completes.
   */
  async updateCycleExecution(
    projectName: string,
    cycleId: string,
    updates: { status: string; executionSessionId?: string; executionToken?: string; planIds: string[] },
  ) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, cycleStore } = this.stores(projectRoot);

    const cycleIndex = await cycleStore.readIndex();
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    const normalizedStatus = updates.status;
    const now = new Date();
    const nowIso = now.toISOString();

    if (cycle.status === "applying") {
      const finalStatus: WorkCycleStatus = normalizedStatus === "completed" ? "applied" : "active";

      if (finalStatus === "applied" && cycle.workspace?.cwd && this.deps.planLifecycle) {
        try {
          await this.deps.planLifecycle.disposeCycleWorkspace({
            strategy: cycle.workspace.strategy,
            cwd: cycle.workspace.cwd,
            projectRoot,
            metadata: cycle.workspace.metadata,
          });
        } catch {
          // Best effort cleanup.
        }
      }

      await cycleStore.updateStatus(cycleId, finalStatus, now);

      if (finalStatus === "applied") {
        const storeIndex = await planStore.readIndex();
        const webPlans = toWebPlanRecords(storeIndex);
        const selected = new Set(updates.planIds);
        const affectedPlans = webPlans.filter(
          (plan) => Object.prototype.hasOwnProperty.call(cycle.plans, plan.id) && !isResolvedPlan(plan),
        );

        await planStore.batchUpdateStatus(
          affectedPlans.map((plan) => ({
            planId: plan.id,
            status: (selected.has(plan.id) ? "applied" : "archived") as DiscoveryPlanStatus,
            updatedAt: nowIso,
          })),
        );

        for (const plan of affectedPlans) {
          await cycleStore.updatePlanStatus(
            cycleId,
            plan.id,
            selected.has(plan.id) ? "applied" : "archived",
            now,
          );
        }

        if (this.deps.state) {
          try {
            await this.deps.state.clearActiveWorkCycleId(projectRoot);
          } catch {
            // Best effort — state cleanup should not block apply finalization.
          }
        }

        await this.appendPreferenceEvent(projectRoot, {
          schemaVersion: 2,
          eventId: randomUUID(),
          timestamp: nowIso,
          action: "apply",
          cycleId,
          plans: affectedPlans.map((plan) => ({
            id: plan.id,
            title: plan.title,
            summary: normalizeString(plan.summary),
            outcome: selected.has(plan.id) ? "applied" : "archived",
          })),
          indexed: false,
        });
      }
    }

    const updatedCycle = await cycleStore.getRecord(cycleId);
    return { cycle: updatedCycle ?? cycle, planIds: updates.planIds };
  }

  /**
   * Read cycle records for a project.
   */
  async getCyclesOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { cycleStore } = this.stores(projectRoot);
    const cycleIndex = await cycleStore.readIndex();
    return {
      cycles: cycleIndex.cycles.map((cycle) => ({
        ...cycle,
        planIds: Object.keys(cycle.plans),
      })),
    };
  }

  /**
   * Read a plan's report markdown by planId.
   */
  async readReport(projectName: string, planId: string): Promise<{ content: string }> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore, reportStore } = this.stores(projectRoot);

    const record = await planStore.getRecord(planId);
    if (!record) throw makeError("Discovery plan not found", "NOT_FOUND");

    if (record.reportFilePath) {
      const content = await reportStore.readByPath(record.reportFilePath) ?? "";
      return { content };
    }

    const runId = record.sourceRunId;
    if (runId) {
      const content = await reportStore.readReport(runId);
      if (content) return { content };
    }

    return { content: "" };
  }

  /**
   * Low-level store reader — used by context aggregation.
   */
  async readStore(projectName: string): Promise<{ version: number; plans: WebPlanRecord[] }> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const { planStore } = this.stores(projectRoot);
    const index = await planStore.readIndex();
    return { version: 1, plans: toWebPlanRecords(index) };
  }

  private async appendPreferenceEvent(projectRoot: string, event: PreferenceEvent): Promise<void> {
    if (!this.deps.preferenceEvents || event.plans.length === 0) return;
    try {
      await this.deps.preferenceEvents.forProject(projectRoot).appendEvent(event);
    } catch (error) {
      this.deps.logger?.warn("[always-on/memory] failed to persist preference event", {
        projectRoot,
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async computeApplyReadiness(
    projectRoot: string,
    cycle: WorkCycleRecord,
    selectedPlanIds: string[],
  ): Promise<ApplyProjectReadiness> {
    const selected = new Set(selectedPlanIds);
    const unselectedCommitShas = Object.entries(cycle.plans)
      .filter(([planId, state]) => (
        !selected.has(planId) &&
        state.status !== "applied" &&
        state.status !== "archived"
      ))
      .flatMap(([, state]) => state.commitShas ?? []);

    try {
      const changedFiles = await generateApplyChangedFileList(
        cycle.workspace.cwd,
        cycle.baseCommit,
        unselectedCommitShas,
      );
      return checkApplyProjectReadiness({
        projectRoot,
        workspaceCwd: cycle.workspace.cwd,
        baseCommit: cycle.baseCommit,
        changedFiles,
      });
    } catch (error) {
      return {
        isProjectGit: false,
        status: "unknown",
        changedFiles: [],
        affectedPaths: [],
        conflictingPaths: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function makeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function enforceApplyReadiness(
  readiness: ApplyProjectReadiness,
  options: QueueCycleApplyOptions,
): void {
  if (readiness.status === "dirty") {
    throw makeError(
      "Project has uncommitted changes in files touched by the selected plans. Please handle those changes before applying.",
      "PROJECT_DIRTY",
    );
  }
  if (
    (readiness.status === "diverged" ||
      readiness.status === "changed") &&
    !options.allowDivergedProject
  ) {
    throw makeError(readiness.message, "PROJECT_DIVERGED");
  }
}
