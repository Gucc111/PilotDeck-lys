import type { GatewayEvent } from "../../../gateway/index.js";
import type { AlwaysOnConfig } from "../../infra/config/index.js";
import type { DiscoveryPlanStore } from "../../infra/storage/json/DiscoveryPlanStore.js";
import type { WorkCycleStore } from "../../infra/storage/json/WorkCycleStore.js";
import type { WorkCycleRecord } from "../../infra/storage/types.js";
import type { SessionConfigOverrides } from "../shared/SessionConfigOverrides.js";
import type { AgentTurnRunner } from "../shared/AgentTurnRunner.js";
import type { PhaseEventEmitter } from "../shared/PhaseEventEmitter.js";

export type ApplyPhaseDeps = {
  config: AlwaysOnConfig;
  projectKey: string;
  sessionOverrides: SessionConfigOverrides;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  turnRunner: AgentTurnRunner;
  events: PhaseEventEmitter;
  excludeTools: string[];
};

export type ApplyPhaseInput = {
  runId: string;
  cycle: WorkCycleRecord;
  plans: Array<{ id: string; title: string }>;
  planIds?: string[];
  projectName: string;
  projectRoot: string;
};

export type ApplyPhaseOutput = {
  events: GatewayEvent[];
  error?: { code: string; message: string };
  sessionKey: string;
};
