import type { GatewayChannelKey } from "../../../gateway/index.js";
import {
  generateChangedFileList,
  isGitRepository,
  revertCommits,
} from "../../infra/git/index.js";
import { deriveApplySessionKey, pickFirstError } from "../shared/index.js";
import { buildApplyPrompt } from "./prompts.js";
import type { ApplyPhaseDeps, ApplyPhaseInput, ApplyPhaseOutput } from "./types.js";

const APPLY_CHANNEL: GatewayChannelKey = "always-on/apply";

export class ApplyPhase {
  constructor(private readonly deps: ApplyPhaseDeps) {}

  async execute(input: ApplyPhaseInput): Promise<ApplyPhaseOutput> {
    const { cycle, projectRoot } = input;

    const selectedPlanIds = new Set(input.planIds ?? Object.keys(cycle.plans));
    const selectedPlanStates = [...selectedPlanIds].map((planId) => ({
      planId,
      state: cycle.plans[planId],
    }));

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

    const sessionKey = deriveApplySessionKey(this.deps.projectKey, input.runId);
    this.deps.events.emit(input.runId, "apply_started", { outcome: "executed" });
    this.deps.sessionOverrides.set(sessionKey, {
      cwd: projectRoot,
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...this.deps.excludeTools],
    });

    try {
      const events = await this.deps.turnRunner.run({
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
        this.deps.events.emit(input.runId, "run_failed", {
          outcome: "failed",
          telemetryPhase: "apply",
          error: { code: error.code ?? "apply_failed", message: error.message },
        });
      } else {
        this.deps.events.emit(input.runId, "apply_completed", { outcome: "executed" });
      }
      return {
        events,
        sessionKey,
        error: error ? { code: error.code ?? "apply_failed", message: error.message } : undefined,
      };
    } finally {
      this.deps.sessionOverrides.delete(sessionKey);
      await this.deps.turnRunner.closeSession(sessionKey);
    }
  }
}
