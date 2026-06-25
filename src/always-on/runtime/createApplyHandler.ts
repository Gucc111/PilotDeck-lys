import { randomUUID } from "node:crypto";
import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { AlwaysOnApplyInput, AlwaysOnApplyResult } from "../../gateway/protocol/types.js";
import { resolveAlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../config/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";

export type CreateApplyHandlerDeps = {
  gateway: Gateway;
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  alwaysOnConfig?: AlwaysOnConfig;
  telemetry?: TelemetryClient;
};

/**
 * Build a lightweight apply handler that does NOT depend on
 * `AlwaysOnManager` or `DiscoveryScheduler`. It reads the cycle from
 * disk and delegates to `DiscoveryFire.runApplyPhase`, which only
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
    const defaultPlanIds = planIndex.plans
      .filter((plan) => (
        cycle.planIds.includes(plan.id) &&
        plan.status !== "applied" &&
        plan.status !== "archived"
      ))
      .map((plan) => plan.id);
    const selectedPlanIds = new Set(input.planIds ?? defaultPlanIds);
    const resolvedPlanIds = input.planIds ?? ((cycle.executions ?? []).length > 0 ? defaultPlanIds : undefined);
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
    const executionPlanIds = new Set((cycle.executions ?? []).map((execution) => execution.planId));
    if ((cycle.executions ?? []).length > 0 && defaultPlanIds.some((planId) => !executionPlanIds.has(planId))) {
      return {
        sessionKey: "",
        error: {
          code: "missing_execution_metadata",
          message: "Cycle mixes active plans with and without execution commit metadata.",
        },
      };
    }
    const cyclePlans = planIndex.plans
      .filter((p) => cycle.planIds.includes(p.id) && selectedPlanIds.has(p.id))
      .map((p) => ({ id: p.id, title: p.title }));

    const baseConfig = deps.alwaysOnConfig ?? defaultAlwaysOnConfig();
    const minimalDeps: DiscoveryFireDependencies = {
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

    const fire = new DiscoveryFire(minimalDeps);
    const runId = randomUUID();
    const result = await fire.runApplyPhase({
      runId,
      cycle,
      plans: cyclePlans,
      planIds: resolvedPlanIds,
      projectName: input.projectName,
      projectRoot: input.projectKey,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  };
}
