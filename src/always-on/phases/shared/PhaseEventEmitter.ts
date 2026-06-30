import type { TelemetryClient } from "../../../telemetry/index.js";
import type {
  AlwaysOnEventPhase,
} from "../../infra/storage/types.js";
import type { AlwaysOnEventStore } from "../../infra/storage/log/AlwaysOnEventStore.js";
import type { AlwaysOnTelemetryPhase, PhaseEventExtra } from "./types.js";

export type PhaseEventEmitterDeps = {
  projectKey: string;
  eventStore: AlwaysOnEventStore;
  uuid: () => string;
  now: () => Date;
  telemetry?: TelemetryClient;
};

export class PhaseEventEmitter {
  constructor(private readonly deps: PhaseEventEmitterDeps) {}

  emit(runId: string, phase: AlwaysOnEventPhase, extra?: PhaseEventExtra): void {
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
}

function toTelemetryAlwaysOnPhase(phase: AlwaysOnEventPhase): AlwaysOnTelemetryPhase {
  if (phase.startsWith("workspace_")) return "workspace";
  if (phase.startsWith("execution_")) return "execution";
  if (phase.startsWith("report_")) return "report";
  if (phase.startsWith("apply_")) return "apply";
  return "discovery";
}
