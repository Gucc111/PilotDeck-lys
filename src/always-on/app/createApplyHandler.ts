import { randomUUID } from "node:crypto";
import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { AlwaysOnApplyInput, AlwaysOnApplyResult } from "../../gateway/protocol/types.js";
import { resolveAlwaysOnPaths } from "../infra/storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../infra/storage/json/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../infra/storage/json/WorkCycleStore.js";
import { AlwaysOnPipeline, type AlwaysOnPipelineDependencies } from "../orchestration/AlwaysOnPipeline.js";
import { SessionConfigOverrides } from "../phases/shared/SessionConfigOverrides.js";
import { DiscoveryStateStore } from "../infra/storage/json/DiscoveryStateStore.js";
import { DiscoveryReportStore } from "../infra/storage/file/DiscoveryReportStore.js";
import { AlwaysOnEventStore } from "../infra/storage/log/AlwaysOnEventStore.js";
import { WorkspaceProviderRegistry } from "../phases/workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "../phases/shared/RunContextRegistry.js";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../infra/config/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";

export type CreateApplyHandlerDeps = {
  gateway: Gateway;
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  onTurnEvent?: AlwaysOnPipelineDependencies["onTurnEvent"];
  alwaysOnConfig?: AlwaysOnConfig;
  telemetry?: TelemetryClient;
};

/**
 * Build a lightweight apply handler that does NOT depend on
 * `AlwaysOnManager` or `DiscoveryScheduler`. It reads the cycle from
 * disk and delegates to `AlwaysOnPipeline.runApplyPhase`, which only
 * requires `gateway`, `sessionOverrides`, and the cycle record.
 */
export function createApplyHandler(
  deps: CreateApplyHandlerDeps,
): (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult> {
  return async (input) => {
    const paths = resolveAlwaysOnPaths({
      pilotHome: deps.pilotHome,
      projectKey: input.projectKey,
    });

    const cycleStore = new WorkCycleStore(paths);
    const cycle = await cycleStore.getRecord(input.workCycleId);
    if (!cycle) {
      return {
        sessionKey: "",
        error: { code: "cycle_not_found", message: `Work cycle ${input.workCycleId} not found` },
      };
    }

    if (!cycle.workspace?.cwd) {
      return {
        sessionKey: "",
        error: { code: "missing_workspace", message: "Cycle has no associated workspace to apply" },
      };
    }

    const planStore = new DiscoveryPlanStore(paths);
    const planIndex = await planStore.readIndex();
    const cyclePlanIds = new Set(Object.keys(cycle.plans));
    const defaultPlanIds = planIndex.plans
      .filter((plan) => (
        cyclePlanIds.has(plan.id) &&
        plan.status !== "applied" &&
        plan.status !== "archived"
      ))
      .map((plan) => plan.id);
    const selectedPlanIds = new Set(input.planIds ?? defaultPlanIds);
    const resolvedPlanIds = input.planIds ?? defaultPlanIds;
    const defaultPlanIdSet = new Set(defaultPlanIds);
    if (selectedPlanIds.size === 0 || [...selectedPlanIds].some((planId) => !defaultPlanIdSet.has(planId))) {
      return {
        sessionKey: "",
        error: {
          code: "invalid_selection",
          message: "Selected plans must be active plans in the cycle.",
        },
      };
    }
    const cyclePlans = planIndex.plans
      .filter((p) => cyclePlanIds.has(p.id) && selectedPlanIds.has(p.id))
      .map((p) => ({ id: p.id, title: p.title }));

    const baseConfig = deps.alwaysOnConfig ?? defaultAlwaysOnConfig();
    const minimalDeps: AlwaysOnPipelineDependencies = {
      config: baseConfig,
      paths,
      projectKey: input.projectKey,
      gateway: deps.gateway,
      runContexts: new AlwaysOnRunContextRegistry(),
      workspaceRegistry: new WorkspaceProviderRegistry(),
      sessionOverrides: deps.sessionOverrides,
      stateStore: new DiscoveryStateStore(paths),
      planStore,
      cycleStore,
      reportStore: new DiscoveryReportStore(paths),
      eventStore: new AlwaysOnEventStore(paths),
      uuid: () => randomUUID(),
      now: () => new Date(),
      onTurnEvent: deps.onTurnEvent,
      telemetry: deps.telemetry,
    };

    const fire = new AlwaysOnPipeline(minimalDeps);
    const runId = randomUUID();
    const result = await fire.runApplyPhase({
      runId,
      cycle,
      plans: cyclePlans,
      planIds: resolvedPlanIds,
      allowDivergedProject: input.allowDivergedProject,
      projectName: input.projectName,
      projectRoot: input.projectKey,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  };
}
