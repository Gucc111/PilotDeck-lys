import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { PermissionRule } from "../../permission/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { AlwaysOnConfig } from "../infra/config/index.js";
import { AlwaysOnError } from "../infra/errors.js";
import type {
  DiscoveryPlanRecord,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../infra/storage/types.js";
import type { AlwaysOnPipelineResult } from "./types.js";
import type { AlwaysOnPaths } from "../infra/storage/AlwaysOnPaths.js";
import { DiscoveryReportStore } from "../infra/storage/file/DiscoveryReportStore.js";
import { DiscoveryPlanStore } from "../infra/storage/json/DiscoveryPlanStore.js";
import { DiscoveryStateStore } from "../infra/storage/json/DiscoveryStateStore.js";
import { WorkCycleStore } from "../infra/storage/json/WorkCycleStore.js";
import { AlwaysOnEventStore } from "../infra/storage/log/AlwaysOnEventStore.js";
import type { PreferenceEventStore } from "../infra/storage/log/PreferenceEventStore.js";
import { ApplyPhase } from "../phases/apply/ApplyPhase.js";
import { DiscoveryPhase } from "../phases/discovery/DiscoveryPhase.js";
import type { LoggerLike, PreferenceLlmOptions } from "../phases/discovery/memory/index.js";
import { ExecutionPhase } from "../phases/execution/ExecutionPhase.js";
import { ReportPhase } from "../phases/report/ReportPhase.js";
import {
  AgentTurnRunner,
  AlwaysOnFailurePolicy,
  deriveApplySessionKey,
  deriveDiscoverySessionKey,
  deriveExecutionSessionKey,
  deriveReportSessionKey,
  PhaseEventEmitter,
  ReportFallbackWriter,
} from "../phases/shared/index.js";
import { WorkspacePhase } from "../phases/workspace/WorkspacePhase.js";
import type { WorkspaceProviderRegistry } from "../phases/workspace/WorkspaceProviderRegistry.js";
import type { AlwaysOnRunContextRegistry } from "../phases/shared/RunContextRegistry.js";
import {
  UNATTENDED_SESSION_EXCLUDED_TOOLS,
  type SessionConfigOverrides,
} from "../phases/shared/SessionConfigOverrides.js";

export type AlwaysOnPipelineDependencies = {
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

export type AlwaysOnPipelineRunInput = {
  /** Pre-allocated runId (already used by the lock + state store). */
  runId: string;
  startedAt: Date;
};

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

export class AlwaysOnPipeline {
  private readonly events: PhaseEventEmitter;
  private readonly turnRunner: AgentTurnRunner;
  private readonly failurePolicy: AlwaysOnFailurePolicy;
  private readonly fallbackWriter: ReportFallbackWriter;
  private readonly phases: {
    discovery: DiscoveryPhase;
    workspace: WorkspacePhase;
    execution: ExecutionPhase;
    report: ReportPhase;
    apply: ApplyPhase;
  };

  constructor(private readonly deps: AlwaysOnPipelineDependencies) {
    this.events = new PhaseEventEmitter({
      projectKey: deps.projectKey,
      eventStore: deps.eventStore,
      uuid: deps.uuid,
      now: deps.now,
      telemetry: deps.telemetry,
    });
    this.turnRunner = new AgentTurnRunner({
      gateway: deps.gateway,
      projectKey: deps.projectKey,
      onTurnEvent: deps.onTurnEvent,
    });
    this.failurePolicy = new AlwaysOnFailurePolicy({
      projectKey: deps.projectKey,
      events: this.events,
      disableAlwaysOnProject: deps.disableAlwaysOnProject,
    });
    this.fallbackWriter = new ReportFallbackWriter({ reportStore: deps.reportStore });

    const excludeTools = [...UNATTENDED_SESSION_EXCLUDED_TOOLS];
    this.phases = {
      discovery: new DiscoveryPhase({
        config: deps.config,
        paths: deps.paths,
        projectKey: deps.projectKey,
        runContexts: deps.runContexts,
        sessionOverrides: deps.sessionOverrides,
        stateStore: deps.stateStore,
        planStore: deps.planStore,
        cycleStore: deps.cycleStore,
        turnRunner: this.turnRunner,
        events: this.events,
        logger: deps.logger,
        preferenceEventStore: deps.preferenceEventStore,
        preferenceLlm: deps.preferenceLlm,
        excludeTools,
        now: deps.now,
      }),
      workspace: new WorkspacePhase({
        projectKey: deps.projectKey,
        paths: deps.paths,
        workspaceRegistry: deps.workspaceRegistry,
        stateStore: deps.stateStore,
        cycleStore: deps.cycleStore,
        events: this.events,
        uuid: deps.uuid,
        now: deps.now,
      }),
      execution: new ExecutionPhase({
        config: deps.config,
        paths: deps.paths,
        projectKey: deps.projectKey,
        runContexts: deps.runContexts,
        sessionOverrides: deps.sessionOverrides,
        planStore: deps.planStore,
        cycleStore: deps.cycleStore,
        turnRunner: this.turnRunner,
        events: this.events,
        now: deps.now,
        excludeTools,
        permissionRules: ALWAYS_ON_EXECUTION_DENY_RULES,
      }),
      report: new ReportPhase({
        config: deps.config,
        paths: deps.paths,
        projectKey: deps.projectKey,
        runContexts: deps.runContexts,
        planStore: deps.planStore,
        stateStore: deps.stateStore,
        reportStore: deps.reportStore,
        turnRunner: this.turnRunner,
        events: this.events,
        fallbackWriter: this.fallbackWriter,
        now: deps.now,
      }),
      apply: new ApplyPhase({
        config: deps.config,
        projectKey: deps.projectKey,
        sessionOverrides: deps.sessionOverrides,
        planStore: deps.planStore,
        cycleStore: deps.cycleStore,
        turnRunner: this.turnRunner,
        events: this.events,
        excludeTools,
      }),
    };
  }

  static deriveDiscoverySessionKey(projectKey: string, runId: string): string {
    return deriveDiscoverySessionKey(projectKey, runId);
  }

  static deriveExecutionSessionKey(projectKey: string, runId: string): string {
    return deriveExecutionSessionKey(projectKey, runId);
  }

  static deriveReportSessionKey(projectKey: string, runId: string): string {
    return deriveReportSessionKey(projectKey, runId);
  }

  static deriveApplySessionKey(projectKey: string, runId: string): string {
    return deriveApplySessionKey(projectKey, runId);
  }

  async runApplyPhase(input: {
    runId: string;
    cycle: WorkCycleRecord;
    plans: Array<{ id: string; title: string }>;
    planIds?: string[];
    allowDivergedProject?: boolean;
    projectName: string;
    projectRoot: string;
  }): Promise<{ events: GatewayEvent[]; error?: { code: string; message: string }; sessionKey: string }> {
    return this.phases.apply.execute(input);
  }

  async rerunPlan(input: {
    planId: string;
    runId: string;
    startedAt: Date;
  }): Promise<AlwaysOnPipelineResult> {
    const { planId, runId, startedAt } = input;

    const planRecord = await this.deps.planStore.getRecord(planId);
    if (!planRecord) {
      return failedResult(runId, startedAt, startedAt, planId, {
        code: "plan_not_found",
        message: `Plan ${planId} not found`,
      });
    }

    if (
      planRecord.status === "completed" ||
      planRecord.status === "completed_no_report" ||
      planRecord.status === "applied" ||
      planRecord.status === "archived" ||
      planRecord.status === "executing"
    ) {
      return failedResult(runId, startedAt, startedAt, planId, {
        code: "plan_not_rerunnable",
        message: `Plan ${planId} is ${planRecord.status} and cannot be rerun.`,
      });
    }

    const planMarkdown = await this.deps.planStore.readPlanMarkdown(planId);
    if (!planMarkdown) {
      return failedResult(runId, startedAt, startedAt, planId, {
        code: "plan_body_missing",
        message: `Plan markdown for ${planId} not found on disk`,
      });
    }

    await this.deps.planStore.updateStatus(planId, { status: "ready" });
    const state = await this.deps.stateStore.read(startedAt);
    return this.runPlanPhases({
      runId,
      startedAt,
      state,
      plan: planRecord,
      planMarkdown,
    });
  }

  async run(input: AlwaysOnPipelineRunInput): Promise<AlwaysOnPipelineResult> {
    const { runId, startedAt } = input;
    const state = await this.deps.stateStore.read(startedAt);
    const discovery = await this.phases.discovery.execute({ runId, startedAt, state });

    if (discovery.kind === "failed") {
      const finishedAt = this.deps.now();
      this.events.emit(runId, "run_failed", {
        error: discovery.error,
        outcome: "failed",
      });
      await this.failurePolicy.disableAfterFailure({
        runId,
        stage: "discovery",
        error: discovery.error,
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        now: finishedAt,
      });
      return failedResult(runId, startedAt, finishedAt, "", discovery.error);
    }

    if (discovery.kind === "no_plan") {
      return discovery.result;
    }

    return this.runPlanPhases({
      runId,
      startedAt,
      state,
      plan: discovery.plan.record,
      planMarkdown: discovery.plan.markdown,
    });
  }

  private async runPlanPhases(input: {
    runId: string;
    startedAt: Date;
    state: Awaited<ReturnType<DiscoveryStateStore["read"]>>;
    plan: DiscoveryPlanRecord;
    planMarkdown: string;
  }): Promise<AlwaysOnPipelineResult> {
    const { runId, startedAt, state, plan, planMarkdown } = input;

    let workspace: WorkspaceHandle;
    let cycle: WorkCycleRecord;
    try {
      const workspaceResult = await this.phases.workspace.execute({
        runId,
        state,
        planId: plan.id,
        planTitle: plan.title,
        startedAt,
      });
      workspace = workspaceResult.handle;
      cycle = workspaceResult.cycle;
    } catch (error) {
      const finishedAt = this.deps.now();
      const failure = normalizeError(error, "workspace_prepare_failed");
      this.events.emit(runId, "run_failed", {
        planId: plan.id,
        error: failure,
        outcome: "failed",
        telemetryPhase: "workspace",
      });
      await this.failurePolicy.disableAfterFailure({
        runId,
        planId: plan.id,
        stage: "workspace",
        error: failure,
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId: plan.id,
        now: finishedAt,
      });
      return failedResult(runId, startedAt, finishedAt, plan.id, failure);
    }

    const execution = await this.phases.execution.execute({
      runId,
      startedAt,
      plan,
      planMarkdown,
      workspace,
      cycle,
      keepSessionOpen: true,
    });

    if (execution.error) {
      const failure = {
        code: execution.error.code ?? "execution_failed",
        message: execution.error.message,
      };
      this.events.emit(runId, "run_failed", {
        planId: plan.id,
        error: failure,
        outcome: "failed",
        telemetryPhase: "execution",
      });
      await this.failurePolicy.disableAfterFailure({
        runId,
        planId: plan.id,
        stage: "execution",
        error: failure,
      });
      await this.turnRunner.closeSession(execution.sessionKey);
      const finishedAt = this.deps.now();
      const reportFilePath = await this.fallbackWriter.write({
        runId,
        plan,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: `execution_failed: ${execution.error.message}`,
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
      await this.deps.planStore.updateStatus(plan.id, {
        status: "failed",
        reportFilePath,
        workCycleId: cycle.id,
      });
      await this.deps.stateStore.markFireCompleted({
        outcome: "failed",
        runId,
        planId: plan.id,
        now: finishedAt,
      });
      return {
        outcome: "failed",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        planId: plan.id,
        workspace,
        reportFilePath,
        error: failure,
      };
    }

    const report = await this.phases.report.execute({
      sessionKey: execution.sessionKey,
      runId,
      startedAt,
      plan,
      workspace,
      cycle,
      executionCommitShas: execution.commitShas,
    });

    return {
      outcome: report.outcome,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: report.finishedAt.toISOString(),
      planId: plan.id,
      workspace,
      reportFilePath: report.reportFilePath,
      error: report.error,
    };
  }
}

function normalizeError(error: unknown, fallbackCode: string): { code: string; message: string } {
  return {
    code: error instanceof AlwaysOnError ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function failedResult(
  runId: string,
  startedAt: Date,
  finishedAt: Date,
  planId: string,
  error: { code: string; message: string },
): AlwaysOnPipelineResult {
  return {
    outcome: "failed",
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    planId,
    error,
  };
}
