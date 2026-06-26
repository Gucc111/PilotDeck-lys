/**
 * Always-On protocol types. See `docs/always-on/02-pilotdeck-always-on-rewrite-plan.md`.
 *
 * These types are storage-shaped and runtime-shaped; they describe what gets
 * serialized to disk and what flows through the runtime modules. They should
 * not depend on agent/model/tool internals.
 */

export type AlwaysOnDiscoveryOutcome =
  | "executed"
  | "no_plan"
  | "failed"
  | "aborted";

export type AlwaysOnDormantState = {
  since: string;
  lastBaselineAt: string;
  lastChangeAt?: string;
};

/** @deprecated Retained for lazy migration from pre-WorkCycle state files. */
export type AlwaysOnCurrentWorkspaceRef = {
  runId: string;
  strategy: WorkspaceStrategyId;
  cwd: string;
  metadata: Record<string, string>;
};

export type AlwaysOnDiscoveryState = {
  schemaVersion: 1;
  lastFireStartedAt?: string;
  lastFireCompletedAt?: string;
  lastFireOutcome?: AlwaysOnDiscoveryOutcome;
  lastPlanId?: string;
  lastRunId?: string;
  todayKey: string;
  todayRunCount: number;
  consecutiveFailures: number;
  dormant?: AlwaysOnDormantState;
  activeWorkCycleId?: string;
  /** @deprecated Retained for lazy migration; replaced by activeWorkCycleId. */
  currentWorkspace?: AlwaysOnCurrentWorkspaceRef;
};

export type AlwaysOnChannelLease = {
  schemaVersion: 1;
  channelKey: string;
  writerId: string;
  projectKey: string;
  sessionKey: string;
  writtenAt: string;
  agentBusy: boolean;
  lastUserMsgAt?: string | null;
};

export type DiscoveryPlanStatus =
  | "ready"
  | "executing"
  | "completed"
  | "completed_no_report"
  | "failed"
  | "applied"
  | "archived";

export type WorkCycleStatus = "active" | "applying" | "applied" | "archived";

export type WorkspaceStrategyId = "git-worktree" | "snapshot-copy";

export type WorkCycleExecutionStatus = "completed" | "failed";

export type WorkCycleDependencyAnalysisStatus = "clean" | "dependent" | "failed";

/** @deprecated Retained for schema v1 WorkCycle migration. */
export type WorkCycleExecutionRecord = {
  executionId: string;
  runId: string;
  planId: string;
  status: WorkCycleExecutionStatus;
  startedAt: string;
  finishedAt: string;
  baseCommit: string;
  beforeHead: string;
  afterHead: string;
  commitShas: string[];
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: WorkCycleDependencyAnalysisStatus;
};

export type WorkCyclePlanAttempt = {
  runId: string;
  status: WorkCycleExecutionStatus;
  startedAt: string;
  finishedAt: string;
  beforeHead: string;
  afterHead: string;
  commitShas: string[];
  error?: { code: string; message: string };
};

export type CyclePlanState = {
  status: DiscoveryPlanStatus;
  commitShas: string[];
  beforeHead?: string;
  afterHead?: string;
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: WorkCycleDependencyAnalysisStatus;
  lastRunId?: string;
  updatedAt: string;
  attempts?: WorkCyclePlanAttempt[];
};

export type WorkspaceHandle = {
  runId: string;
  projectKey: string;
  strategy: WorkspaceStrategyId;
  cwd: string;
  metadata: Record<string, string>;
};

/** @deprecated Retained for lazy migration from pre-WorkCycle plan records. */
export type DiscoveryPlanWorkspaceRef = {
  strategy: WorkspaceStrategyId;
  handle: string;
  cwd: string;
};

export type DiscoveryPlanRecord = {
  id: string;
  title: string;
  createdAt: string;
  status: DiscoveryPlanStatus;
  summary: string;
  rationale: string;
  dedupeKey: string;
  sourceRunId: string;
  planFilePath: string;
  reportFilePath?: string;
  workCycleId?: string;
  /** @deprecated Retained for lazy migration; replaced by workCycleId. */
  workspace?: DiscoveryPlanWorkspaceRef;
};

export type WorkCycleRecord = {
  id: string;
  projectKey: string;
  status: WorkCycleStatus;
  baseCommit: string;
  workspace: {
    strategy: WorkspaceStrategyId;
    cwd: string;
    metadata: Record<string, string>;
  };
  plans: Record<string, CyclePlanState>;
  createdAt: string;
  createdByRunId: string;
  appliedAt?: string;
  archivedAt?: string;
};

export type WorkCycleIndex = {
  schemaVersion: 2;
  cycles: WorkCycleRecord[];
};

export type DiscoveryPlanIndex = {
  schemaVersion: 1;
  plans: DiscoveryPlanRecord[];
};

export type GateBlockReason =
  | "disabled"
  | "project_disabled"
  | "project_missing"
  | "dormant_no_signal"
  | "agent_busy"
  | "recent_user_msg"
  | "cooldown"
  | "daily_budget"
  | "lock_busy"
  | "cycle_full";

export type GateResult =
  | { ok: true; lease?: AlwaysOnChannelLease }
  | { ok: false; reason: GateBlockReason };

export type AlwaysOnEventPhase =
  | "discovery_started"
  | "plan_produced"
  | "no_plan"
  | "workspace_started"
  | "workspace_ready"
  | "execution_started"
  | "execution_completed"
  | "report_started"
  | "report_produced"
  | "apply_started"
  | "apply_completed"
  | "always_on_disabled"
  | "run_completed"
  | "run_failed";

export type AlwaysOnPhaseEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  projectKey: string;
  phase: AlwaysOnEventPhase;
  timestamp: string;
  title?: string;
  planId?: string;
  outcome?: AlwaysOnDiscoveryOutcome;
  error?: { code: string; message: string };
  message?: string;
  disabledReason?: { stage: string; code: string; message: string };
};

export type PreferencePlanOutcome = "applied" | "archived";

export type PreferenceEventPlan = {
  id: string;
  title: string;
  summary: string;
  dedupeKey: string;
  outcome: PreferencePlanOutcome;
};

export type PreferenceEvent = {
  schemaVersion: 2;
  eventId: string;
  timestamp: string;
  action: "apply" | "archive";
  cycleId: string;
  plans: PreferenceEventPlan[];
  indexed: boolean;
};

export type DiscoveryFireResult =
  | {
      outcome: "no_plan";
      runId: string;
      startedAt: string;
      finishedAt: string;
    }
  | {
      outcome: "executed" | "failed" | "aborted";
      runId: string;
      startedAt: string;
      finishedAt: string;
      planId: string;
      workspace?: WorkspaceHandle;
      reportFilePath?: string;
      error?: { code: string; message: string };
    };
