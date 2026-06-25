/**
 * Discovery plan lifecycle service.
 *
 * Extracted from `ui/server/discovery-plans.js`. Owns:
 *   - plan store read/write/normalize
 *   - queue / update / archive operations (with guards)
 *   - run event + log emission
 *   - overview building
 *
 * Depends on injectable I/O adapters so tests can substitute stubs.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import {
  computeExecutionStatus,
  computePlanStatus,
  normalizeString,
  normalizeStringList,
  pickLatestIsoTimestamp,
  sortDiscoveryPlans,
  toIsoTimestamp,
  toTimestampValue,
  truncateText,
  type WebPlanContextRefs,
  type WebPlanRecord,
  type WebPlanSession,
} from "./DiscoveryPlanStatus.js";

// Re-export so callers only need one import for the full service.
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

const INDEX_VERSION = 1;
const STRUCTURE_VERSION = 1;

type PlanIndex = {
  version: number;
  plans: WebPlanRecord[];
};

const EMPTY_STORE: PlanIndex = { version: INDEX_VERSION, plans: [] };

// ---------------------------------------------------------------------------
// Dependencies — callers inject these so the service stays testable
// ---------------------------------------------------------------------------

/** Emits run-history events + run log lines. */
export type RunEventSink = {
  appendRunEvent(
    projectRoot: string,
    event: Record<string, unknown>,
  ): Promise<unknown>;
  appendRunLog(
    projectRoot: string,
    runId: string,
    lines: string[],
  ): Promise<void>;
  appendRunLogEvent(
    projectRoot: string,
    runId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  formatLogLine(entry: Record<string, unknown>): string;
};

export type ProjectPathResolver = {
  /** Resolve a display-name / encoded project name to the absolute root. */
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

export type WorkspaceManager = {
  applyWorktreeChanges(
    workspaceCwd: string,
    projectRoot: string,
  ): Promise<{ applied: boolean; diff?: string; error?: string }>;
  disposeWorkspace(
    strategy: string,
    cwd: string,
    projectRoot: string,
  ): Promise<void>;
};

export type StateManager = {
  clearActiveWorkCycleId(projectRoot: string): Promise<void>;
};

export type DiscoveryPlanServiceDeps = {
  pilotHome: string;
  resolveProjectId: (projectRoot: string) => string;
  paths: ProjectPathResolver;
  sessions: SessionLister;
  activity: SessionActivityChecker;
  events: RunEventSink;
  workspace?: WorkspaceManager;
  state?: StateManager;
};

// ---------------------------------------------------------------------------
// Paths (mirrors ui/server/discovery-plans.js helpers)
// ---------------------------------------------------------------------------

function resolveProjectDir(pilotHome: string, resolveProjectId: (root: string) => string, projectRoot: string): string {
  const projectId = resolveProjectId(resolve(projectRoot));
  return join(pilotHome, "always-on", "projects", projectId);
}

function indexPath(projectDir: string): string {
  return join(projectDir, "plans", "index.json");
}

function planMarkdownDir(projectDir: string): string {
  return join(projectDir, "plans");
}

function relativePlanPath(planId: string): string {
  return join("plans", `${planId}.md`);
}

// ---------------------------------------------------------------------------
// Normalization
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
    dedupeKey: normalizeString(record?.dedupeKey, id),
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

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

async function readPlanStore(projectDir: string): Promise<PlanIndex> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.plans)) {
      return { ...EMPTY_STORE };
    }
    const version =
      typeof parsed.schemaVersion === "number"
        ? parsed.schemaVersion
        : typeof parsed.version === "number"
          ? parsed.version
          : INDEX_VERSION;
    return {
      version,
      plans: (parsed.plans as unknown[]).map((p) => normalizeDiscoveryPlanRecord(p as Record<string, unknown>)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...EMPTY_STORE };
    }
    throw error;
  }
}

async function writePlanStore(projectDir: string, store: PlanIndex): Promise<void> {
  await fs.mkdir(planMarkdownDir(projectDir), { recursive: true });
  await fs.writeFile(
    indexPath(projectDir),
    `${JSON.stringify({ schemaVersion: INDEX_VERSION, plans: store.plans }, null, 2)}\n`,
    "utf8",
  );
}

async function readPlanBody(projectDir: string, planFilePath: string): Promise<string> {
  const absolutePath = isAbsolute(planFilePath) ? planFilePath : resolve(projectDir, planFilePath);
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

async function readRawPlanRecord(projectDir: string, planId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.plans)) return null;
    return (parsed.plans as Record<string, unknown>[]).find((p) => p.id === planId) ?? null;
  } catch {
    return null;
  }
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
  cycle: { planIds: string[] },
  plans: WebPlanRecord[],
  planIds?: string[],
): string[] {
  if (planIds === undefined) {
    return plans
      .filter((plan) => cycle.planIds.includes(plan.id) && !isResolvedPlan(plan))
      .map((plan) => plan.id);
  }
  const selected = new Set<string>();
  for (const id of planIds) {
    const normalized = normalizeString(id);
    if (normalized) selected.add(normalized);
  }
  return [...selected];
}

function executionMap(executions: CycleExecutionRecord[]): Map<string, CycleExecutionRecord> {
  const byPlanId = new Map<string, CycleExecutionRecord>();
  for (const execution of executions) {
    if (!byPlanId.has(execution.planId)) {
      byPlanId.set(execution.planId, execution);
    }
  }
  return byPlanId;
}

function validateApplySelection(
  cycle: { planIds: string[]; executions?: CycleExecutionRecord[] },
  plans: WebPlanRecord[],
  selectedPlanIds: string[],
  explicitSelection: boolean,
): { legacyWorkspaceApply: boolean } {
  if (selectedPlanIds.length === 0) {
    throw makeError("Select at least one plan to apply", "INVALID_SELECTION");
  }

  const activePlans = plans.filter((plan) => cycle.planIds.includes(plan.id) && !isResolvedPlan(plan));
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

  const executions = cycle.executions ?? [];
  if (executions.some((execution) => execution.dependencyAnalysisStatus === "failed")) {
    throw makeError(
      "Cycle contains a plan whose dependency analysis failed; discard the entire cycle instead.",
      "INVALID_SELECTION",
    );
  }

  if (executions.length === 0) {
    if (explicitSelection) {
      throw makeError(
        "Legacy cycles without execution metadata only support whole-cycle apply.",
        "INVALID_SELECTION",
      );
    }
    return { legacyWorkspaceApply: true };
  }

  const byPlanId = executionMap(executions);
  if (activePlans.some((plan) => !byPlanId.has(plan.id))) {
    throw makeError(
      "Cycle mixes plans with and without execution metadata and cannot be applied safely.",
      "INVALID_SELECTION",
    );
  }

  const selected = new Set(selectedPlanIds);
  for (const planId of selectedPlanIds) {
    const execution = byPlanId.get(planId);
    if (!execution || execution.status !== "completed") {
      throw makeError(`Plan ${planId} has no successful execution to apply`, "INVALID_SELECTION");
    }
    const missing = execution.dependsOnPlanIds.filter((dependencyId) => !selected.has(dependencyId));
    if (missing.length > 0) {
      throw makeError(
        `Plan ${planId} depends on unselected plan(s): ${missing.join(", ")}`,
        "INVALID_SELECTION",
      );
    }
  }

  return { legacyWorkspaceApply: false };
}

function validateArchiveSelection(
  cycle: { planIds: string[]; executions?: CycleExecutionRecord[] },
  plans: WebPlanRecord[],
  selectedPlanIds: string[],
): { archiveWholeCycle: boolean } {
  if (selectedPlanIds.length === 0) {
    throw makeError("Select at least one plan to archive", "INVALID_SELECTION");
  }

  const activePlans = plans.filter((plan) => cycle.planIds.includes(plan.id) && !isResolvedPlan(plan));
  const activeIds = new Set(activePlans.map((plan) => plan.id));
  for (const planId of selectedPlanIds) {
    if (!activeIds.has(planId)) {
      throw makeError(`Plan ${planId} is not an active plan in this cycle`, "INVALID_SELECTION");
    }
  }

  const selected = new Set(selectedPlanIds);
  const archiveWholeCycle = activePlans.every((plan) => selected.has(plan.id));
  if (archiveWholeCycle) return { archiveWholeCycle: true };

  const executions = cycle.executions ?? [];
  if (executions.some((execution) => execution.dependencyAnalysisStatus === "failed")) {
    throw makeError(
      "Cycle contains a plan whose dependency analysis failed; only whole-cycle archive is allowed.",
      "INVALID_SELECTION",
    );
  }

  const byPlanId = executionMap(executions);
  const completedWithoutMetadata = activePlans.filter((plan) => (
    (plan.status === "completed" || plan.status === "completed_no_report") &&
    !byPlanId.has(plan.id)
  ));
  if (completedWithoutMetadata.length > 0) {
    throw makeError(
      "Legacy completed plans without execution metadata only support whole-cycle archive.",
      "INVALID_SELECTION",
    );
  }

  for (const plan of activePlans) {
    if (selected.has(plan.id)) continue;
    const execution = byPlanId.get(plan.id);
    const removedDependencies = (execution?.dependsOnPlanIds ?? []).filter((dependencyId) => selected.has(dependencyId));
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

  private projectDir(projectRoot: string): string {
    return resolveProjectDir(this.deps.pilotHome, this.deps.resolveProjectId, projectRoot);
  }

  async getPlansOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const store = await readPlanStore(projectDir);
    if (store.plans.length === 0) return { plans: [] };

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

    const cycleIndex = await readCycleIndex(projectDir);
    const cycleWorkspaceMap = new Map(cycleIndex.cycles.map((c) => [c.id, c.workspace]));
    const executionByPlanId = new Map<string, CycleExecutionRecord>();
    for (const cycle of cycleIndex.cycles) {
      for (const execution of cycle.executions ?? []) {
        executionByPlanId.set(execution.planId, execution);
      }
    }

    const plans = await Promise.all(
      store.plans.map(async (plan) => {
        const body = await readPlanBody(projectDir, plan.planFilePath);
        const session = plan.executionSessionId
          ? (sessionsById.get(plan.executionSessionId) as WebPlanSession) || null
          : null;
        const overview = buildOverview(plan, body, session, isActive);
        if (!overview.workspace && plan.workCycleId) {
          overview.workspace = cycleWorkspaceMap.get(plan.workCycleId);
        }
        const execution = executionByPlanId.get(plan.id);
        if (execution) {
          overview.executionCommitShas = [...execution.commitShas];
          overview.dependsOnPlanIds = [...execution.dependsOnPlanIds];
          overview.dependencyReasons = [...execution.dependencyReasons];
          overview.dependencyAnalysisStatus = execution.dependencyAnalysisStatus;
        }
        return overview;
      }),
    );

    return { plans: sortDiscoveryPlans(plans) };
  }

  async archiveCycle(projectName: string, cycleId: string, planIds?: string[]) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
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

    const store = await readPlanStore(projectDir);
    const selectedPlanIds = normalizePlanSelection(cycle, store.plans, planIds);
    const { archiveWholeCycle } = validateArchiveSelection(cycle, store.plans, selectedPlanIds);
    const now = new Date().toISOString();

    for (const plan of store.plans) {
      if (selectedPlanIds.includes(plan.id) && !isResolvedPlan(plan)) {
        plan.status = "archived";
        plan.updatedAt = now;
      }
    }
    await writePlanStore(projectDir, store);

    const hasRemainingPlan = store.plans.some((plan) => (
      cycle.planIds.includes(plan.id) && !isResolvedPlan(plan)
    ));
    const shouldCloseCycle = archiveWholeCycle || !hasRemainingPlan;

    if (shouldCloseCycle && cycle.workspace?.cwd && this.deps.workspace) {
      try {
        await this.deps.workspace.disposeWorkspace(
          cycle.workspace.strategy,
          cycle.workspace.cwd,
          projectRoot,
        );
      } catch {
        // Best effort — workspace may already be gone.
      }
    }

    if (shouldCloseCycle) {
      cycle.status = "archived";
      cycle.archivedAt = now;
    }
    await writeCycleIndex(projectDir, cycleIndex);

    if (shouldCloseCycle && this.deps.state) {
      try {
        await this.deps.state.clearActiveWorkCycleId(projectRoot);
      } catch {
        // Best effort — state cleanup should not block archive.
      }
    }

    return { archived: true, planIds: selectedPlanIds };
  }

  /**
   * Mark a cycle as "applying" and return its metadata. The actual apply
   * agent loop is triggered via `gateway.alwaysOnApply` — the caller
   * (discovery-plans.js) fires that RPC after this method returns.
   */
  async queueCycleApply(projectName: string, cycleId: string, planIds?: string[]) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
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

    const store = await readPlanStore(projectDir);
    const selectedPlanIds = normalizePlanSelection(cycle, store.plans, planIds);
    const { legacyWorkspaceApply } = validateApplySelection(
      cycle,
      store.plans,
      selectedPlanIds,
      planIds !== undefined,
    );
    const cyclePlans = store.plans.filter((p) => selectedPlanIds.includes(p.id));

    cycle.status = "applying";
    await writeCycleIndex(projectDir, cycleIndex);

    const now = new Date().toISOString();
    const executionToken = randomUUID();

    await this.deps.events.appendRunEvent(projectRoot, {
      runId: executionToken,
      kind: "cycle-apply",
      sourceId: cycle.id,
      title: `Apply cycle: ${cyclePlans.map((p) => p.title).join(", ")}`,
      status: "queued",
      timestamp: now,
      startedAt: now,
      metadata: { cycleId: cycle.id, planIds: selectedPlanIds, source: "apply" },
    });

    return {
      cycle,
      projectRoot,
      executionToken,
      planIds: selectedPlanIds,
      legacyWorkspaceApply,
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
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    const cycle = cycleIndex.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw makeError("Work cycle not found", "NOT_FOUND");

    const normalizedStatus = updates.status;
    const now = new Date().toISOString();

    if (cycle.status === "applying") {
      const finalStatus = normalizedStatus === "completed" ? "applied" : "active";

      if (finalStatus === "applied" && cycle.workspace?.cwd && this.deps.workspace) {
        try {
          await this.deps.workspace.disposeWorkspace(
            cycle.workspace.strategy,
            cycle.workspace.cwd,
            projectRoot,
          );
        } catch {
          // Best effort cleanup.
        }
      }

      cycle.status = finalStatus;
      if (finalStatus === "applied") cycle.appliedAt = now;
      await writeCycleIndex(projectDir, cycleIndex);

      if (finalStatus === "applied") {
        const store = await readPlanStore(projectDir);
        const selected = new Set(updates.planIds);
        for (const plan of store.plans) {
          if (cycle.planIds.includes(plan.id) && !isResolvedPlan(plan)) {
            plan.status = selected.has(plan.id) ? "applied" : "archived";
            plan.updatedAt = now;
          }
        }
        await writePlanStore(projectDir, store);

        if (this.deps.state) {
          try {
            await this.deps.state.clearActiveWorkCycleId(projectRoot);
          } catch {
            // Best effort — state cleanup should not block apply finalization.
          }
        }
      }
    }

    return { cycle, planIds: updates.planIds };
  }

  /**
   * Read cycle records for a project.
   */
  async getCyclesOverview(projectName: string) {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);
    const cycleIndex = await readCycleIndex(projectDir);
    return { cycles: cycleIndex.cycles };
  }

  /**
   * Read a plan's report markdown by planId.
   * Returns the raw markdown string (empty if no report exists yet).
   */
  async readReport(projectName: string, planId: string): Promise<{ content: string }> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    const projectDir = this.projectDir(projectRoot);

    const rawRecord = await readRawPlanRecord(projectDir, planId);
    if (!rawRecord) throw makeError("Discovery plan not found", "NOT_FOUND");

    let reportPath = typeof rawRecord.reportFilePath === "string" ? rawRecord.reportFilePath : "";

    if (!reportPath) {
      const runId =
        typeof rawRecord.sourceDiscoverySessionId === "string" ? rawRecord.sourceDiscoverySessionId
        : typeof rawRecord.sourceRunId === "string" ? rawRecord.sourceRunId
        : "";
      if (runId) {
        const inferred = join("reports", `${runId}.md`);
        const inferredContent = await readPlanBody(projectDir, inferred);
        if (inferredContent) return { content: inferredContent };
      }
      return { content: "" };
    }

    const content = await readPlanBody(projectDir, reportPath);
    return { content };
  }

  /**
   * Low-level store reader — used by context aggregation.
   */
  async readStore(projectName: string): Promise<PlanIndex> {
    const projectRoot = await this.deps.paths.extractProjectDirectory(projectName);
    return readPlanStore(this.projectDir(projectRoot));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cycle store I/O
// ---------------------------------------------------------------------------

type CycleExecutionRecord = {
  executionId: string;
  runId: string;
  planId: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  baseCommit: string;
  beforeHead: string;
  afterHead: string;
  commitShas: string[];
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: string;
};

type CycleIndex = {
  schemaVersion: number;
  cycles: Array<{
    id: string;
    projectKey: string;
    status: string;
    workspace: { strategy: string; cwd: string; metadata?: Record<string, string> };
    planIds: string[];
    executions?: CycleExecutionRecord[];
    createdAt: string;
    createdByRunId?: string;
    appliedAt?: string;
    archivedAt?: string;
  }>;
};

const EMPTY_CYCLE_INDEX: CycleIndex = { schemaVersion: 1, cycles: [] };

async function readCycleIndex(projectDir: string): Promise<CycleIndex> {
  const filePath = join(projectDir, "cycles", "index.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.cycles)) {
      return normalizeCycleIndex(parsed as CycleIndex);
    }
    return { ...EMPTY_CYCLE_INDEX };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...EMPTY_CYCLE_INDEX };
    }
    throw error;
  }
}

function normalizeCycleIndex(index: CycleIndex): CycleIndex {
  return {
    schemaVersion: 1,
    cycles: index.cycles.map((cycle) => ({
      ...cycle,
      planIds: Array.isArray(cycle.planIds) ? [...cycle.planIds] : [],
      executions: (cycle.executions ?? []).map((execution) => ({
        ...execution,
        commitShas: normalizeStringList(execution.commitShas),
        dependsOnPlanIds: normalizeStringList(execution.dependsOnPlanIds),
        dependencyReasons: normalizeStringList(execution.dependencyReasons),
        dependencyAnalysisStatus: normalizeString(execution.dependencyAnalysisStatus, "clean"),
      })),
    })),
  };
}

async function writeCycleIndex(projectDir: string, index: CycleIndex): Promise<void> {
  const dir = join(projectDir, "cycles");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, "index.json"),
    `${JSON.stringify({ schemaVersion: 1, cycles: index.cycles }, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function makeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
