import type { PhaseEventEmitter } from "./PhaseEventEmitter.js";
import type { DisableAlwaysOnProject, DisableAlwaysOnStage } from "./types.js";

export type AlwaysOnFailurePolicyDeps = {
  projectKey: string;
  events: PhaseEventEmitter;
  disableAlwaysOnProject?: DisableAlwaysOnProject;
};

export class AlwaysOnFailurePolicy {
  constructor(private readonly deps: AlwaysOnFailurePolicyDeps) {}

  async disableAfterFailure(input: {
    runId: string;
    planId?: string;
    stage: DisableAlwaysOnStage;
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
      this.deps.events.emit(input.runId, "always_on_disabled", {
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
      this.deps.events.emit(input.runId, "always_on_disabled", {
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
}
