import type {
  AlwaysOnDiscoveryState,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../../protocol/types.js";
import type { AlwaysOnPaths } from "../../infra/storage/AlwaysOnPaths.js";
import type { DiscoveryStateStore } from "../../infra/storage/json/DiscoveryStateStore.js";
import type { WorkCycleStore } from "../../infra/storage/json/WorkCycleStore.js";
import type { WorkspaceProviderRegistry } from "../../workspace/WorkspaceProviderRegistry.js";
import type { PhaseEventEmitter } from "../shared/PhaseEventEmitter.js";

export type WorkspacePhaseDeps = {
  projectKey: string;
  paths: AlwaysOnPaths;
  workspaceRegistry: WorkspaceProviderRegistry;
  stateStore: DiscoveryStateStore;
  cycleStore: WorkCycleStore;
  events: PhaseEventEmitter;
  uuid: () => string;
  now: () => Date;
  fileExists?: (path: string) => boolean;
};

export type WorkspacePhaseInput = {
  runId: string;
  state: AlwaysOnDiscoveryState;
  planId?: string;
  planTitle: string;
  startedAt?: Date;
};

export type WorkspacePhaseOutput = {
  handle: WorkspaceHandle;
  cycle: WorkCycleRecord;
};
