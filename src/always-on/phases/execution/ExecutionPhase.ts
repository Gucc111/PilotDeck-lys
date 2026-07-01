import type { GatewayChannelKey } from "../../../gateway/index.js";
import { AlwaysOnError } from "../../infra/errors.js";
import type { CyclePlanState, WorkCycleRecord, WorkspaceHandle } from "../../infra/storage/types.js";
import type { ExecutionRunContext } from "../shared/RunContextRegistry.js";
import {
  analyzeExecutionDependencies,
  commitDirtyWorkspace,
  getHeadCommit,
  getStatusPorcelain,
  isGitRepository,
  listCommitsBetween,
} from "../../infra/git/index.js";
import { deriveExecutionSessionKey, pickFirstError } from "../shared/index.js";
import { buildExecutionPrompt } from "./prompts.js";
import type {
  ExecutionGitState,
  ExecutionPhaseDeps,
  ExecutionPhaseInput,
  ExecutionPhaseOutput,
} from "./types.js";

const EXECUTION_CHANNEL: GatewayChannelKey = "always-on/execute";

export class ExecutionPhase {
  constructor(private readonly deps: ExecutionPhaseDeps) {}

  async execute(input: ExecutionPhaseInput): Promise<ExecutionPhaseOutput> {
    const { plan, runId, workspace, cycle } = input;
    const sessionKey = deriveExecutionSessionKey(this.deps.projectKey, runId);
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: workspace.cwd,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...this.deps.excludeTools],
      permissionRules: { deny: this.deps.permissionRules },
    });

    const executionCtx: ExecutionRunContext = {
      kind: "execution",
      sessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan,
    };
    this.deps.runContexts.register(executionCtx);
    await this.deps.planStore.updateStatus(plan.id, {
      status: "executing",
      workCycleId: cycle.id,
    });
    await this.deps.cycleStore.addPlan(cycle.id, plan.id);
    this.deps.events.emit(runId, "execution_started", { planId: plan.id, title: plan.title });

    let executionError: { code?: string; message: string } | undefined;
    let executionGitState: ExecutionGitState | undefined;
    try {
      executionGitState = await this.prepareExecutionGitState({ workspace, cycle });
    } catch (error) {
      executionError = {
        code: error instanceof AlwaysOnError ? error.code : "execution_git_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      if (!executionError) {
        const events = await this.deps.turnRunner.run({
          sessionKey,
          channelKey: EXECUTION_CHANNEL,
          runId: `${runId}.execute`,
          message: buildExecutionPrompt({
            plan,
            planMarkdown: input.planMarkdown,
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
      this.deps.runContexts.unregister(sessionKey);
      this.deps.sessionOverrides.delete(sessionKey);
      await this.deps.turnRunner.closeSession(sessionKey);
    }

    let commitShas: string[] = [];
    if (executionGitState) {
      const recorded = await this.recordExecutionCommits({
        cycle,
        workspace,
        planId: plan.id,
        runId,
        startedAt: input.startedAt,
        baseCommit: executionGitState.baseCommit,
        beforeHead: executionGitState.beforeHead,
        status: executionError ? "failed" : "completed",
        error: executionError,
      });
      commitShas = recorded.commitShas;
      if (recorded.error && !executionError) {
        executionError = recorded.error;
      }
    }

    if (!executionError) {
      this.deps.events.emit(runId, "execution_completed", { planId: plan.id, title: plan.title });
    }

    return { commitShas, error: executionError };
  }

  private async prepareExecutionGitState(input: {
    workspace: WorkspaceHandle;
    cycle: WorkCycleRecord;
  }): Promise<ExecutionGitState> {
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
}
