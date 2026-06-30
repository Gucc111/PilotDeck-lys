import type {
  AlwaysOnDiscoveryState,
  DiscoveryFireResult,
  DiscoveryPlanRecord,
} from "../../protocol/types.js";
import type { AlwaysOnConfig } from "../../infra/config/index.js";
import type { AlwaysOnPaths } from "../../infra/storage/AlwaysOnPaths.js";
import type { DiscoveryPlanStore } from "../../infra/storage/json/DiscoveryPlanStore.js";
import type { DiscoveryStateStore } from "../../infra/storage/json/DiscoveryStateStore.js";
import type { WorkCycleStore } from "../../infra/storage/json/WorkCycleStore.js";
import type { PreferenceEventStore } from "../../infra/storage/log/PreferenceEventStore.js";
import type { AlwaysOnRunContextRegistry } from "../../runtime/AlwaysOnRunContextRegistry.js";
import type { SessionConfigOverrides } from "../../runtime/SessionConfigOverrides.js";
import type { LoggerLike, PreferenceLlmOptions } from "./memory/index.js";
import type { AgentTurnRunner } from "../shared/AgentTurnRunner.js";
import type { PhaseEventEmitter } from "../shared/PhaseEventEmitter.js";

export type DiscoveryPhaseDeps = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  runContexts: AlwaysOnRunContextRegistry;
  sessionOverrides: SessionConfigOverrides;
  stateStore: DiscoveryStateStore;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  turnRunner: AgentTurnRunner;
  events: PhaseEventEmitter;
  logger?: LoggerLike;
  preferenceEventStore?: PreferenceEventStore;
  preferenceLlm?: PreferenceLlmOptions;
  excludeTools: string[];
  now: () => Date;
  fileExists?: (path: string) => boolean;
};

export type DiscoveryPhaseInput = {
  runId: string;
  startedAt: Date;
  state: AlwaysOnDiscoveryState;
};

export type DiscoveryPhaseOutput =
  | {
      kind: "plan";
      plan: { record: DiscoveryPlanRecord; markdown: string };
    }
  | {
      kind: "no_plan";
      result: DiscoveryFireResult;
    }
  | {
      kind: "failed";
      error: { code: string; message: string };
    };
