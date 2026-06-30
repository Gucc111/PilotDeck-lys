import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../gateway/index.js";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { buildChatDigest } from "../context/ChatDigestBuilder.js";
import type { AlwaysOnConfig } from "../infra/config/index.js";
import { buildFallbackReport, parseReportMarkdown, type ReportMetadata } from "../contracts/ReportContract.js";
import { AlwaysOnError } from "../protocol/errors.js";
import type {
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  AlwaysOnEventPhase,
  CyclePlanState,
  DiscoveryFireResult,
  DiscoveryPlanRecord,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../protocol/types.js";
import type { AlwaysOnPaths } from "../infra/storage/AlwaysOnPaths.js";
import { AlwaysOnEventStore } from "../infra/storage/log/AlwaysOnEventStore.js";
import { DiscoveryPlanStore } from "../infra/storage/json/DiscoveryPlanStore.js";
import { DiscoveryReportStore } from "../infra/storage/file/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../infra/storage/json/DiscoveryStateStore.js";
import { WorkCycleStore } from "../infra/storage/json/WorkCycleStore.js";
import type { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import {
  analyzeExecutionDependencies,
  commitDirtyWorkspace,
  generateChangedFileList,
  generatePatchForCommits,
  getHeadCommit,
  getStatusPorcelain,
  isGitRepository,
  listCommitsBetween,
  revertCommits,
} from "../infra/git/index.js";
import type { AlwaysOnRunContextRegistry, ExecutionRunContext, DiscoveryRunContext, ReportRunContext } from "./AlwaysOnRunContextRegistry.js";
import { buildDiscoveryPrompt, buildExecutionPrompt, buildReportPrompt, buildApplyPrompt } from "./discoveryPrompts.js";
import {
  UNATTENDED_SESSION_EXCLUDED_TOOLS,
  type SessionConfigOverrides,
} from "./SessionConfigOverrides.js";
import type { PermissionRule } from "../../permission/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { PreferenceEventStore } from "../infra/storage/log/PreferenceEventStore.js";
import {
  preparePreferenceMemory,
  type LoggerLike,
  type PreferenceLlmOptions,
} from "../memory/PreferenceExtractor.js";

export type DiscoveryFireDependencies = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  gateway: Gateway;
  runContexts: AlwaysOnRunContextRegistry;
  workspaceRegistry: WorkspaceProviderRegistry;
  sessionOverrides: SessionConfigOverrides;
  stateStore: DiscoveryStateStore;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  reportStore: DiscoveryReportStore;
  eventStore: AlwaysOnEventStore;
  disableAlwaysOnProject?: (input: {
    projectKey: string;
    stage: "discovery" | "workspace" | "execution" | "internal";
    runId: string;
    planId?: string;
    error: { code: string; message: string };
  }) => Promise<void>;
  uuid: () => string;
  now: () => Date;
  logger?: LoggerLike;
  onTurnEvent?: (sessionKey: string, channelKey: string, event: GatewayEvent) => void;
  telemetry?: TelemetryClient;
  preferenceEventStore?: PreferenceEventStore;
  preferenceLlm?: PreferenceLlmOptions;
};

export type DiscoveryFireRunInput = {
  /** Pre-allocated runId (already used by the lock + state store). */
  runId: string;
  startedAt: Date;
};

const DISCOVERY_CHANNEL: GatewayChannelKey = "always-on/discovery";
const EXECUTION_CHANNEL: GatewayChannelKey = "always-on/execute";
const REPORT_CHANNEL: GatewayChannelKey = "always-on/report";
const APPLY_CHANNEL: GatewayChannelKey = "always-on/apply";

/**
 * Deny rules injected into the execution phase session. These override
 * `bypassPermissions` because deny rules always win in `PermissionRuntime.decide()`.
 * Prevents the agent from pushing code or modifying remote configuration.
 */
export const ALWAYS_ON_EXECUTION_DENY_RULES: PermissionRule[] = [
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "git remote*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git push*" },
  { source: "policy", behavior: "deny", toolName: "bash", pattern: "*git remote*" },
];

function toTelemetryAlwaysOnPhase(phase: AlwaysOnEventPhase): "discovery" | "workspace" | "execution" | "report" | "apply" {
  if (phase.startsWith("workspace_")) return "workspace";
  if (phase.startsWith("execution_")) return "execution";
  if (phase.startsWith("report_")) return "report";
  if (phase.startsWith("apply_")) return "apply";
  return "discovery";
}


export class DiscoveryFire {
  constructor(private readonly deps: DiscoveryFireDependencies) {}

  private emitEvent(
    runId: string,
    phase: AlwaysOnEventPhase,
    extra?: {
      title?: string;
      planId?: string;
      outcome?: AlwaysOnDiscoveryOutcome;
      error?: { code: string; message: string };
      message?: string;
      disabledReason?: { stage: string; code: string; message: string };
      telemetryPhase?: "discovery" | "workspace" | "execution" | "report" | "apply";
    },
  ): void {
    const telemetryPhase = extra?.telemetryPhase ?? toTelemetryAlwaysOnPhase(phase);
    const { telemetryPhase: _telemetryPhase, ...eventExtra } = extra ?? {};
    this.deps.telemetry?.trackFeatureLoopStage({
      module: "always_on",
      ownerModule: "always_on",
      executionKind: "always_on",
      phase: telemetryPhase,
      loopStage: "module_event",
      outcome: phase === "run_failed" ? "failed" : "success",
      metadata: {
        event: phase,
        runId,
        planId: extra?.planId,
        outcome: extra?.outcome,
      },
    });
    if (extra?.error) {
      this.deps.telemetry?.trackError(extra.error.message, {
        module: "always_on",
        ownerModule: "always_on",
        executionKind: "always_on",
        phase: telemetryPhase,
        loopStage: "loop_end",
        errorCategory: "loop_error",
        code: extra.error.code,
        metadata: {
          runId,
          phase,
          planId: extra.planId,
        },
      });
    }
    this.deps.eventStore
      .appendEvent({
        schemaVersion: 1,
        eventId: this.deps.uuid(),
        runId,
        projectKey: this.deps.projectKey,
        phase,
        timestamp: this.deps.now().toISOString(),
        ...eventExtra,
      })
      .catch(() => undefined);
  }

  private async disableAlwaysOnAfterFailure(input: {
    runId: string;
    planId?: string;
    stage: "discovery" | "workspace" | "execution" | "internal";
    error: { code: string; message: string };
  }): Promise<void> {
    const message = "Always-On 已因失败自动关闭，请手动重新开启。";
    try {
      await this.deps.disableAlwaysOnProject?.({
        projectKey: this.deps.projectKey,
        runId: input.runId,
        planId: input.planId,
        stage: input.stage,
        error: input.error,
      });
      this.emitEvent(input.runId, "always_on_disabled", {
        planId: input.planId,
        error: input.error,
        message,
        disabledReason: {
          stage: input.stage,
          code: input.error.code,
          message,
        },
        outcome: "failed",
        telemetryPhase: input.stage === "internal" ? "discovery" : input.stage,
      });
    } catch (error) {
      this.emitEvent(input.runId, "always_on_disabled", {
        planId: input.planId,
        error: {
          code: "always_on_disable_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        message,
        disabledReason: {
          stage: input.stage,
          code: input.error.code,
          message,
        },
        outcome: "failed",
        telemetryPhase: input.stage === "internal" ? "discovery" : input.stage,
      });
    }
  }

  static deriveDiscoverySessionKey(projectKey: string, runId: string): string {
    return `always-on/discovery:project=${projectKey}:run=${runId}`;
  }

  static deriveExecutionSessionKey(projectKey: string, runId: string): string {
    return `always-on/execute:project=${projectKey}:run=${runId}`;
  }

  static deriveReportSessionKey(projectKey: string, runId: string): string {
    return `always-on/report:project=${projectKey}:run=${runId}`;
  }

  static deriveApplySessionKey(projectKey: string, runId: string): string {
    return `always-on/apply:project=${projectKey}:run=${runId}`;
  }

  async runApplyPhase(input: {
    runId: string;
    cycle: WorkCycleRecord;
    plans: Array<{ id: string; title: string }>;
    planIds?: string[];
    projectName: string;
    projectRoot: string;
  }): Promise<{ events: GatewayEvent[]; error?: { code: string; message: string }; sessionKey: string }> {
    const { cycle, projectRoot } = input;

    const selectedPlanIds = new Set(input.planIds ?? Object.keys(cycle.plans));
    const selectedPlanStates = [...selectedPlanIds].map((planId) => ({
      planId,
      state: cycle.plans[planId],
    }));
    const selectedCommitShas = selectedPlanStates.flatMap((entry) => entry.state?.commitShas ?? []);

    if (Object.values(cycle.plans).some((state) => state.dependencyAnalysisStatus === "failed")) {
      return {
        events: [],
        sessionKey: "",
        error: {
          code: "dependency_analysis_failed",
          message: "Cycle contains a plan whose dependency analysis failed.",
        },
      };
    }

    if (selectedPlanStates.some((entry) => !entry.state)) {
      return {
        events: [],
        sessionKey: "",
        error: {
          code: "invalid_selection",
          message: "Selected plans are not all present in this work cycle.",
        },
      };
    }

    for (const { planId, state } of selectedPlanStates) {
      if (!state || (state.status !== "completed" && state.status !== "completed_no_report")) {
        return {
          events: [],
          sessionKey: "",
          error: {
            code: "invalid_selection",
            message: `Plan ${planId} has no successful execution to apply.`,
          },
        };
      }
      if (state.commitShas.length === 0) {
        return {
          events: [],
          sessionKey: "",
          error: {
            code: "invalid_selection",
            message: `Plan ${planId} has no commits to apply.`,
          },
        };
      }
      const missingDependencies = state.dependsOnPlanIds.filter(
        (dependencyId) => !selectedPlanIds.has(dependencyId),
      );
      if (missingDependencies.length > 0) {
        return {
          events: [],
          sessionKey: "",
          error: {
            code: "invalid_selection",
            message: `Plan ${planId} depends on unselected plan(s): ${missingDependencies.join(", ")}`,
          },
        };
      }
    }

    // Archive unselected plans so the worktree HEAD reflects only
    // the selected plans' cumulative effect.
    const unselectedPlanIds = Object.keys(cycle.plans)
      .filter((id) => !selectedPlanIds.has(id))
      .filter((id) => {
        const s = cycle.plans[id];
        return s && s.status !== "applied" && s.status !== "archived";
      });

    if (unselectedPlanIds.length > 0) {
      const unselectedCommits = unselectedPlanIds.flatMap(
        (id) => cycle.plans[id]?.commitShas ?? [],
      );
      if (unselectedCommits.length > 0) {
        const reverted = await revertCommits(cycle.workspace.cwd, unselectedCommits);
        if (!reverted.reverted) {
          return {
            events: [],
            sessionKey: "",
            error: {
              code: "archive_revert_failed",
              message: reverted.error ?? "Failed to revert unselected plan commits before apply",
            },
          };
        }
      }
      for (const planId of unselectedPlanIds) {
        await this.deps.cycleStore.updatePlanStatus(cycle.id, planId, "archived");
        await this.deps.planStore.updateStatus(planId, { status: "archived" });
      }
    }

    const isProjectGit = await isGitRepository(projectRoot);
    const changedFiles = await generateChangedFileList(
      cycle.workspace.cwd,
      cycle.baseCommit,
    );

    const sessionKey = DiscoveryFire.deriveApplySessionKey(this.deps.projectKey, input.runId);
    this.emitEvent(input.runId, "apply_started", { outcome: "executed" });
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: projectRoot,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    try {
      const events = await this.drainTurn({
        sessionKey,
        channelKey: APPLY_CHANNEL,
        runId: `${input.runId}.apply`,
        message: buildApplyPrompt({
          workspaceCwd: cycle.workspace.cwd,
          baseCommit: cycle.baseCommit,
          isProjectGit,
          changedFiles,
          projectRoot,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
      const error = pickFirstError(events);
      if (error) {
        this.emitEvent(input.runId, "run_failed", {
          outcome: "failed",
          telemetryPhase: "apply",
          error: { code: error.code ?? "apply_failed", message: error.message },
        });
      } else {
        this.emitEvent(input.runId, "apply_completed", { outcome: "executed" });
      }
      return {
        events,
        sessionKey,
        error: error ? { code: error.code ?? "apply_failed", message: error.message } : undefined,
      };
    } finally {
      this.deps.sessionOverrides.delete(sessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }
  }

  async rerunPlan(input: {
    planId: string;
    runId: string;
    startedAt: Date;
  }): Promise<DiscoveryFireResult> {
    const { planId, runId, startedAt } = input;

    const planRecord = await this.deps.planStore.getRecord(planId);
    if (!planRecord) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_not_found", message: `Plan ${planId} not found` },
      };
    }

    if (
      planRecord.status === "completed" ||
      planRecord.status === "completed_no_report" ||
      planRecord.status === "applied" ||
      planRecord.status === "archived" ||
      planRecord.status === "executing"
    ) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: {
          code: "plan_not_rerunnable",
          message: `Plan ${planId} is ${planRecord.status} and cannot be rerun.`,
        },
      };
    }

    const planMarkdown = await this.deps.planStore.readPlanMarkdown(planId);
    if (!planMarkdown) {
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        planId,
        error: { code: "plan_body_missing", message: `Plan markdown for ${planId} not found on disk` },
      };
    }

    await this.deps.planStore.updateStatus(planId, { status: "ready" });

    const state = await this.deps.stateStore.read(startedAt);

    // Phase 2: Workspace
    this.emitEvent(runId, "workspace_started", { planId });
    let workspace: WorkspaceHandle;
    let workCycle: WorkCycleRecord;
    try {
      const wsResult = await this.runWorkspacePhase({ runId, state, planTitle: planRecord.title });
      workspace = wsResult.handle;
      workCycle = wsResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent(runId, "run_failed", { planId, error: { code, message }, outcome: "failed", telemetryPhase: "workspace" });
      await this.disableAlwaysOnAfterFailure({
        runId,
        planId,
        stage: "workspace",
        error: { code, message },
      });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId, now: finishedAt });
      return { outcome: "failed", runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, error: { code, message } };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();
    this.emitEvent(runId, "workspace_ready", { planId });

    // Phase 3: Execution
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
      permissionRules: { deny: ALWAYS_ON_EXECUTION_DENY_RULES },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planId, { status: "executing", workCycleId: workCycle.id });
    await this.deps.cycleStore.addPlan(workCycle.id, planId);
    this.emitEvent(runId, "execution_started", { planId, title: planRecord.title });

    let executionError: { code?: string; message: string } | undefined;
    let executionCommitShas: string[] = [];
    let executionGitState: { baseCommit: string; beforeHead: string } | undefined;
    try {
      executionGitState = await this.prepareExecutionGitState({ workspace, cycle: workCycle });
    } catch (error) {
      executionError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_git_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      if (!executionError) {
        const events = await this.drainTurn({
          sessionKey: executionSessionKey,
          channelKey: EXECUTION_CHANNEL,
          runId: `${runId}.execute`,
          message: buildExecutionPrompt({
            plan: planRecord,
            planMarkdown,
            workspaceCwd: workspace.cwd,
            workspaceStrategy: workspace.strategy,
            language: this.deps.config.language,
          }),
          mode: "bypassPermissions",
        });
        executionError = pickFirstError(events);
      }
    } catch (error) {
      executionError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.deps.gateway.closeSession({ sessionKey: executionSessionKey, reason: "always-on/done" }).catch(() => undefined);
    }

    if (executionGitState) {
      const recorded = await this.recordExecutionCommits({
        cycle: workCycle,
        workspace,
        planId,
        runId,
        startedAt,
        baseCommit: executionGitState.baseCommit,
        beforeHead: executionGitState.beforeHead,
        status: executionError ? "failed" : "completed",
        error: executionError,
      });
      executionCommitShas = recorded.commitShas;
      if (recorded.error && !executionError) {
        executionError = recorded.error;
      }
    }

    if (executionError) {
      this.emitEvent(runId, "run_failed", { planId, error: { code: executionError.code ?? "execution_failed", message: executionError.message }, outcome: "failed", telemetryPhase: "execution" });
      await this.disableAlwaysOnAfterFailure({
        runId,
        planId,
        stage: "execution",
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      });
      const finishedAt = this.deps.now();
      const reportFilePath = await this.writeFallbackReport({ runId, plan: planRecord, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), reason: `execution_failed: ${executionError.message}`, workspaceStrategy: workspace.strategy, workspaceHandle: workspace.cwd });
      await this.deps.planStore.updateStatus(planId, { status: "failed", reportFilePath, workCycleId: workCycle.id });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId, now: finishedAt });
      return { outcome: "failed", runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, workspace, reportFilePath, error: { code: executionError.code ?? "execution_failed", message: executionError.message } };
    }

    this.emitEvent(runId, "execution_completed", { planId, title: planRecord.title });

    // Phase 4: Report
    this.emitEvent(runId, "report_started", { planId, title: planRecord.title });
    const reportSessionKey = DiscoveryFire.deriveReportSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(reportSessionKey, { cwd: workspace.cwd, permissionMode: "bypassPermissions", bypassAvailable: true, canPrompt: false, excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS] });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey: reportSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportEvents: GatewayEvent[] = [];
    let reportError: { code?: string; message: string } | undefined;
    try {
      reportEvents = await this.drainTurn({
        sessionKey: reportSessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({ plan: planRecord, planMarkdown, workspaceCwd: workspace.cwd, workspaceStrategy: workspace.strategy, executionCommitShas, language: this.deps.config.language }),
        mode: "bypassPermissions",
      });
      reportError = pickFirstError(reportEvents);
    } finally {
      this.deps.runContexts.unregister(reportSessionKey);
      this.deps.sessionOverrides.delete(reportSessionKey);
      await this.deps.gateway.closeSession({ sessionKey: reportSessionKey, reason: "always-on/done" }).catch(() => undefined);
    }

    const finishedAt = this.deps.now();

    if (!reportCtx.report) {
      const assistantText = extractAssistantText(reportEvents);
      if (assistantText) {
        const metadata: ReportMetadata = {
          runId,
          planId,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome: "executed",
          workspaceStrategy: workspace.strategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
          workspaceHandle: workspace.cwd,
        };
        const parsed = parseReportMarkdown(assistantText, metadata);
        const filePath = await this.deps.reportStore.writeReport(runId, parsed.rawContent);
        reportCtx.report = { markdown: parsed.rawContent, filePath, finishedAt };
      }
    }

    const reportDegraded = !reportCtx.report || !!reportError;
    const outcome: AlwaysOnDiscoveryOutcome = "executed";
    const planStatus = reportDegraded ? "completed_no_report" as const : "completed" as const;

    if (!reportDegraded) {
      this.emitEvent(runId, "report_produced", { planId, title: planRecord.title, outcome });
    }
    this.emitEvent(runId, "run_completed", { planId, title: planRecord.title, outcome });

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.writeFallbackReport({ runId, plan: planRecord, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), reason: reportError ? `report_failed: ${reportError.message}` : "report_tool_not_invoked", workspaceStrategy: workspace.strategy, workspaceHandle: workspace.cwd });
    }

    await this.deps.planStore.updateStatus(planId, { status: planStatus, reportFilePath, workCycleId: workCycle.id });
    await this.deps.stateStore.markFireCompleted({ outcome, runId, planId, now: finishedAt });

    return { outcome, runId, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), planId, workspace, reportFilePath, error: reportError ? { code: reportError.code ?? "report_degraded", message: reportError.message } : undefined };
  }

  async run(input: DiscoveryFireRunInput): Promise<DiscoveryFireResult> {
    const { runId, startedAt } = input;

    const state = await this.deps.stateStore.read(startedAt);

    // ── Phase 1: Discovery (bypassPermissions) ──
    this.emitEvent(runId, "discovery_started");
    const discoverySessionKey = DiscoveryFire.deriveDiscoverySessionKey(this.deps.projectKey, runId);

    const activeCycle = state.activeWorkCycleId
      ? await this.deps.cycleStore.getRecord(state.activeWorkCycleId)
      : undefined;
    const existingWorkspace = activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)
      ? { cwd: activeCycle.workspace.cwd, strategy: activeCycle.workspace.strategy, metadata: activeCycle.workspace.metadata }
      : state.currentWorkspace && existsSync(state.currentWorkspace.cwd)
        ? state.currentWorkspace
        : undefined;

    const discoveryCtx: DiscoveryRunContext = {
      kind: "discovery",
      sessionKey: discoverySessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      startedAt,
      planStore: this.deps.planStore,
      planCallCount: 0,
    };
    this.deps.runContexts.register(discoveryCtx);
    this.deps.sessionOverrides.set(discoverySessionKey, {
      cwd: existingWorkspace?.cwd ?? this.deps.projectKey,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    const chatDigest = await buildChatDigest({
      projectRoot: this.deps.projectKey,
      pilotHome: this.deps.paths.pilotHome,
      maxSessions: 10,
      maxPromptsPerSession: 8,
      maxPromptLength: 500,
    });
    discoveryCtx.chatSessionAliases = chatDigest.aliasMap;

    const planIndex = await this.deps.planStore.readIndex();
    const existingPlans = planIndex.plans.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      dedupeKey: p.dedupeKey,
      status: p.status,
    }));

    const preferences = await preparePreferenceMemory({
      extractionThreshold: this.deps.config.memory.extractionThreshold,
      consolidationThreshold: this.deps.config.memory.consolidationThreshold,
      preferencesFile: this.deps.paths.preferencesFile,
      eventStore: this.deps.preferenceEventStore,
      llm: this.deps.preferenceLlm,
      language: this.deps.config.language,
      logger: this.deps.logger,
    });

    let discoveryEvents: GatewayEvent[];
    try {
      discoveryEvents = await this.drainTurn({
        sessionKey: discoverySessionKey,
        channelKey: DISCOVERY_CHANNEL,
        runId: `${runId}.discovery`,
        message: buildDiscoveryPrompt({
          projectRoot: this.deps.projectKey,
          runId,
          createdAt: startedAt.toISOString(),
          chatDir: getPilotProjectChatDir(this.deps.projectKey, this.deps.paths.pilotHome),
          workspace: existingWorkspace
            ? { cwd: existingWorkspace.cwd, strategy: existingWorkspace.strategy }
            : undefined,
          chatDigest,
          existingPlans,
          preferences,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
    } finally {
      this.deps.runContexts.unregister(discoverySessionKey);
      this.deps.sessionOverrides.delete(discoverySessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: discoverySessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const discoveryError = pickFirstError(discoveryEvents);
    if (discoveryError && !discoveryCtx.plan) {
      const finishedAt = this.deps.now();
      this.emitEvent(runId, "run_failed", {
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
        outcome: "failed",
      });
      await this.disableAlwaysOnAfterFailure({
        runId,
        stage: "discovery",
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
      });
      await this.markFailedNoPlan(runId, finishedAt);
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: "",
        error: { code: discoveryError.code ?? "discovery_failed", message: discoveryError.message },
      };
    }

    if (!discoveryCtx.plan) {
      this.emitEvent(runId, "no_plan", { outcome: "no_plan" });
      const finishedAt = this.deps.now();
      await this.deps.stateStore.markFireCompleted({
        outcome: "no_plan",
        runId,
        now: finishedAt,
      });
      await this.deps.stateStore.setDormant(finishedAt);
      return {
        outcome: "no_plan",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    }

    const planRecord = discoveryCtx.plan.record;
    this.emitEvent(runId, "plan_produced", { title: planRecord.title, planId: planRecord.id });

    // ── Phase 2: Workspace (bypassPermissions, agent-driven) ──
    this.emitEvent(runId, "workspace_started", { planId: planRecord.id });
    let workspace: WorkspaceHandle;
    let workCycle: WorkCycleRecord;
    try {
      const wsResult = await this.runWorkspacePhase({ runId, state, planTitle: planRecord.title });
      workspace = wsResult.handle;
      workCycle = wsResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const code = error instanceof AlwaysOnError ? error.code : "workspace_prepare_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent(runId, "run_failed", {
        planId: planRecord.id,
        error: { code, message },
        outcome: "failed",
        telemetryPhase: "workspace",
      });
      await this.disableAlwaysOnAfterFailure({
        runId,
        planId: planRecord.id,
        stage: "workspace",
        error: { code, message },
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId: planRecord.id,
        now: finishedAt,
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: planRecord.id,
        error: { code, message },
      };
    }

    this.assertWorkspaceCwdSafe(workspace);
    workspace.metadata.startedAt = startedAt.toISOString();
    this.emitEvent(runId, "workspace_ready", { planId: planRecord.id });

    // ── Phase 3: Execution (bypassPermissions, plan only) ──
    const executionSessionKey = DiscoveryFire.deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(executionSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
      permissionRules: {
        deny: ALWAYS_ON_EXECUTION_DENY_RULES,
      },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey: executionSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(planRecord.id, {
      status: "executing",
      workCycleId: workCycle.id,
    });
    await this.deps.cycleStore.addPlan(workCycle.id, planRecord.id);
    this.emitEvent(runId, "execution_started", { planId: planRecord.id, title: planRecord.title });

    let executionError: { code?: string; message: string } | undefined;
    let executionCommitShas: string[] = [];
    let executionGitState: { baseCommit: string; beforeHead: string } | undefined;
    try {
      executionGitState = await this.prepareExecutionGitState({ workspace, cycle: workCycle });
    } catch (error) {
      executionError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_git_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      if (!executionError) {
        const events = await this.drainTurn({
          sessionKey: executionSessionKey,
          channelKey: EXECUTION_CHANNEL,
          runId: `${runId}.execute`,
          message: buildExecutionPrompt({
            plan: planRecord,
            planMarkdown: discoveryCtx.plan.markdown,
            workspaceCwd: workspace.cwd,
            workspaceStrategy: workspace.strategy,
            language: this.deps.config.language,
          }),
          mode: "bypassPermissions",
        });
        executionError = pickFirstError(events);
      }
    } catch (error) {
      executionError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.deps.runContexts.unregister(executionSessionKey);
      this.deps.sessionOverrides.delete(executionSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: executionSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    if (executionGitState) {
      const recorded = await this.recordExecutionCommits({
        cycle: workCycle,
        workspace,
        planId: planRecord.id,
        runId,
        startedAt,
        baseCommit: executionGitState.baseCommit,
        beforeHead: executionGitState.beforeHead,
        status: executionError ? "failed" : "completed",
        error: executionError,
      });
      executionCommitShas = recorded.commitShas;
      if (recorded.error && !executionError) {
        executionError = recorded.error;
      }
    }

    if (executionError) {
      this.emitEvent(runId, "run_failed", {
        planId: planRecord.id,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
        outcome: "failed",
        telemetryPhase: "execution",
      });
      await this.disableAlwaysOnAfterFailure({
        runId,
        planId: planRecord.id,
        stage: "execution",
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      });
      const finishedAt = this.deps.now();
      const reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: `execution_failed: ${executionError.message}`,
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
      await this.deps.planStore.updateStatus(planRecord.id, {
        status: "failed",
        reportFilePath,
        workCycleId: workCycle.id,
      });
      await this.deps.stateStore.markFireCompleted({ outcome: "failed", runId, planId: planRecord.id, now: finishedAt });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: planRecord.id,
        workspace,
        reportFilePath,
        error: { code: executionError.code ?? "execution_failed", message: executionError.message },
      };
    }

    this.emitEvent(runId, "execution_completed", { planId: planRecord.id, title: planRecord.title });

    // ── Phase 4: Report (bypassPermissions, independent agent loop) ──
    this.emitEvent(runId, "report_started", { planId: planRecord.id, title: planRecord.title });
    const reportSessionKey = DiscoveryFire.deriveReportSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(reportSessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey: reportSessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan: planRecord,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportEvents: GatewayEvent[] = [];
    let reportError: { code?: string; message: string } | undefined;
    try {
      reportEvents = await this.drainTurn({
        sessionKey: reportSessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({
          plan: planRecord,
          planMarkdown: discoveryCtx.plan.markdown,
          workspaceCwd: workspace.cwd,
          workspaceStrategy: workspace.strategy,
          executionCommitShas,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
      reportError = pickFirstError(reportEvents);
    } finally {
      this.deps.runContexts.unregister(reportSessionKey);
      this.deps.sessionOverrides.delete(reportSessionKey);
      await this.deps.gateway
        .closeSession({ sessionKey: reportSessionKey, reason: "always-on/done" })
        .catch(() => undefined);
    }

    const finishedAt = this.deps.now();

    if (!reportCtx.report) {
      const assistantText = extractAssistantText(reportEvents);
      if (assistantText) {
        const metadata: ReportMetadata = {
          runId,
          planId: planRecord.id,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome: "executed",
          workspaceStrategy: workspace.strategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
          workspaceHandle: workspace.cwd,
        };
        const parsed = parseReportMarkdown(assistantText, metadata);
        const filePath = await this.deps.reportStore.writeReport(runId, parsed.rawContent);
        reportCtx.report = { markdown: parsed.rawContent, filePath, finishedAt };
      }
    }

    const reportDegraded = !reportCtx.report || !!reportError;
    const outcome: AlwaysOnDiscoveryOutcome = "executed";
    const planStatus = reportDegraded ? "completed_no_report" as const : "completed" as const;

    if (!reportDegraded) {
      this.emitEvent(runId, "report_produced", { planId: planRecord.id, title: planRecord.title, outcome });
    }
    this.emitEvent(runId, "run_completed", { planId: planRecord.id, title: planRecord.title, outcome });

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.writeFallbackReport({
        runId,
        plan: planRecord,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: reportError
          ? `report_failed: ${reportError.message}`
          : "report_tool_not_invoked",
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
    }

    await this.deps.planStore.updateStatus(planRecord.id, {
      status: planStatus,
      reportFilePath,
      workCycleId: workCycle.id,
    });
    await this.deps.stateStore.markFireCompleted({
      outcome,
      runId,
      planId: planRecord.id,
      now: finishedAt,
    });

    return {
      outcome,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      planId: planRecord.id,
      workspace,
      reportFilePath,
      error: reportError ? { code: reportError.code ?? "report_degraded", message: reportError.message } : undefined,
    };
  }

  /**
   * Phase 2: Ensure an isolated workspace exists for plan execution.
   *
   * The runtime decides deterministically whether to reuse an existing
   * workspace or create a new one — the agent loop is only started when
   * a fresh workspace is needed.
   */
  private async runWorkspacePhase(input: {
    runId: string;
    state: AlwaysOnDiscoveryState;
    planTitle: string;
  }): Promise<{ handle: WorkspaceHandle; cycle: WorkCycleRecord }> {
    const { runId, state, planTitle } = input;

    if (state.activeWorkCycleId) {
      const activeCycle = await this.deps.cycleStore.getRecord(state.activeWorkCycleId);
      if (activeCycle && activeCycle.status === "active" && existsSync(activeCycle.workspace.cwd)) {
        return {
          handle: {
            runId: activeCycle.createdByRunId,
            projectKey: this.deps.projectKey,
            strategy: activeCycle.workspace.strategy,
            cwd: activeCycle.workspace.cwd,
            metadata: { ...activeCycle.workspace.metadata },
          },
          cycle: activeCycle,
        };
      }
    }

    const { handle } = await this.deps.workspaceRegistry.prepare({
      projectRoot: this.deps.projectKey,
      runId,
      planTitle,
    });

    const cycleId = this.deps.uuid();
    const cycle = await this.deps.cycleStore.create(handle, runId, cycleId, this.deps.now());
    await this.deps.stateStore.setActiveWorkCycleId(cycle.id, this.deps.now());

    return { handle, cycle };
  }

  private assertWorkspaceCwdSafe(workspace: WorkspaceHandle): void {
    if (workspace.cwd === this.deps.projectKey) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        "workspace cwd must not equal projectRoot — refusing to run Always-On turns in the project root.",
      );
    }
    const inWorktree = workspace.cwd.startsWith(this.deps.paths.worktreesDir);
    const inSnapshot = workspace.cwd.startsWith(this.deps.paths.snapshotsDir);
    if (!inWorktree && !inSnapshot) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        `workspace cwd ${workspace.cwd} is outside the configured Always-On workspace bases.`,
      );
    }
  }

  private async prepareExecutionGitState(input: {
    workspace: WorkspaceHandle;
    cycle: WorkCycleRecord;
  }): Promise<{ baseCommit: string; beforeHead: string }> {
    const { workspace, cycle } = input;
    if (!(await isGitRepository(workspace.cwd))) {
      throw new AlwaysOnError(
        "workspace_unavailable",
        `workspace ${workspace.cwd} is not a git repository; Always-On execution commits cannot be tracked.`,
      );
    }
    const beforeHead = await getHeadCommit(workspace.cwd);
    const baseCommit =
      cycle.baseCommit ||
      workspace.metadata.baseCommit ||
      cycle.workspace.metadata?.baseCommit ||
      beforeHead;
    return { baseCommit, beforeHead };
  }

  private async recordExecutionCommits(input: {
    cycle: WorkCycleRecord;
    workspace: WorkspaceHandle;
    planId: string;
    runId: string;
    startedAt: Date;
    baseCommit: string;
    beforeHead: string;
    status: "completed" | "failed";
    error?: { code?: string; message: string };
  }): Promise<{ commitShas: string[]; error?: { code?: string; message: string } }> {
    try {
      await commitDirtyWorkspace(
        input.workspace.cwd,
        `chore(always-on): capture execution ${input.runId}`,
      );
      const remainingStatus = await getStatusPorcelain(input.workspace.cwd);
      if (remainingStatus) {
        return {
          commitShas: [],
          error: {
            code: "workspace_dirty_after_commit",
            message: `Workspace still has uncommitted changes after execution commit: ${remainingStatus}`,
          },
        };
      }

      const afterHead = await getHeadCommit(input.workspace.cwd);
      const commitShas = await listCommitsBetween(
        input.workspace.cwd,
        input.beforeHead,
        afterHead,
      );
      const candidatePlans = Object.entries(input.cycle.plans)
        .filter(([planId, state]) => (
          planId !== input.planId &&
          state.status !== "applied" &&
          state.status !== "archived" &&
          state.commitShas.length > 0
        ))
        .map(([planId, state]) => ({ planId, commitShas: state.commitShas }));
      let dependencyAnalysis: Pick<
        CyclePlanState,
        "dependsOnPlanIds" | "dependencyReasons" | "dependencyAnalysisStatus"
      >;
      try {
        dependencyAnalysis = await analyzeExecutionDependencies({
          workspaceCwd: input.workspace.cwd,
          baseCommit: input.baseCommit,
          previousExecutions: candidatePlans,
          currentCommitShas: commitShas,
        });
      } catch (error) {
        dependencyAnalysis = {
          dependsOnPlanIds: candidatePlans.map((entry) => entry.planId),
          dependencyReasons: [
            `Dependency analysis failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          dependencyAnalysisStatus: "failed",
        };
      }

      await this.deps.cycleStore.recordPlanRun(input.cycle.id, {
        runId: input.runId,
        planId: input.planId,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        finishedAt: this.deps.now().toISOString(),
        beforeHead: input.beforeHead,
        afterHead,
        commitShas,
        error: input.error
          ? { code: input.error.code ?? "execution_failed", message: input.error.message }
          : undefined,
        ...dependencyAnalysis,
      });
      const updatedCycle = await this.deps.cycleStore.getRecord(input.cycle.id);
      if (updatedCycle) {
        input.cycle.plans = updatedCycle.plans;
      }
      return { commitShas };
    } catch (error) {
      const fallbackError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_commit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      try {
        const afterHead = await getHeadCommit(input.workspace.cwd).catch(() => input.beforeHead);
        const commitShas = await listCommitsBetween(
          input.workspace.cwd,
          input.beforeHead,
          afterHead,
        ).catch(() => []);
        await this.deps.cycleStore.recordPlanRun(input.cycle.id, {
          planId: input.planId,
          runId: input.runId,
          status: "failed",
          startedAt: input.startedAt.toISOString(),
          finishedAt: this.deps.now().toISOString(),
          beforeHead: input.beforeHead,
          afterHead,
          commitShas,
          dependsOnPlanIds: [],
          dependencyReasons: [fallbackError.message],
          dependencyAnalysisStatus: "failed",
          error: fallbackError,
        });
      } catch {
        // Best effort: the caller still receives the commit failure.
      }
      return {
        commitShas: [],
        error: fallbackError,
      };
    }
  }

  private async drainTurn(input: {
    sessionKey: string;
    channelKey: GatewayChannelKey;
    runId: string;
    message: string;
    mode: "default" | "bypassPermissions";
  }): Promise<GatewayEvent[]> {
    const events: GatewayEvent[] = [];
    for await (const event of this.deps.gateway.submitTurn({
      sessionKey: input.sessionKey,
      channelKey: input.channelKey,
      message: input.message,
      mode: input.mode,
      runId: input.runId,
      projectKey: this.deps.projectKey,
      telemetry: {
        ownerModule: "always_on",
        executionKind: "always_on",
        phase: String(input.channelKey).startsWith("always-on/")
          ? String(input.channelKey).slice("always-on/".length)
          : undefined,
      },
    })) {
      events.push(event);
      this.deps.onTurnEvent?.(input.sessionKey, input.channelKey, event);
    }
    return events;
  }

  private async writeFallbackReport(input: {
    runId: string;
    plan: DiscoveryPlanRecord;
    startedAt: string;
    finishedAt: string;
    reason: string;
    workspaceStrategy: string;
    workspaceHandle: string;
  }): Promise<string> {
    const metadata: ReportMetadata = {
      runId: input.runId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: "failed",
      workspaceStrategy: input.workspaceStrategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
      workspaceHandle: input.workspaceHandle,
    };
    const markdown = buildFallbackReport({
      metadata,
      title: input.plan.title,
      reason: input.reason,
    });
    return this.deps.reportStore.writeReport(input.runId, markdown);
  }

  private async markFailedNoPlan(
    runId: string,
    finishedAt: Date,
  ): Promise<void> {
    await this.deps.stateStore.markFireCompleted({
      outcome: "failed",
      runId,
      now: finishedAt,
    });
  }
}

export async function acquireDiscoveryLock(
  paths: AlwaysOnPaths,
  payload: { pid: number; startedAt: string; runId: string },
): Promise<boolean> {
  await mkdir(dirname(paths.discoveryLockFile), { recursive: true });
  try {
    await writeFile(paths.discoveryLockFile, JSON.stringify(payload, null, 2), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function releaseDiscoveryLock(paths: AlwaysOnPaths): Promise<void> {
  await unlink(paths.discoveryLockFile).catch(() => undefined);
}

function pickFirstError(events: GatewayEvent[]): { code?: string; message: string } | undefined {
  for (const event of events) {
    if (event.type === "error") {
      return { code: event.code, message: event.message };
    }
  }
  return undefined;
}

function extractAssistantText(events: GatewayEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant_text_delta") {
      text += event.text;
    }
  }
  return text.trim();
}
