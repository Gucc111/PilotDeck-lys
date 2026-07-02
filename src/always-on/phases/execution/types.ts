import type { PermissionRule } from "../../../permission/index.js";
import type {
  DiscoveryPlanRecord,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../../infra/storage/types.js";
import type { AlwaysOnConfig } from "../../infra/config/index.js";
import type { AlwaysOnPaths } from "../../infra/storage/AlwaysOnPaths.js";
import type { DiscoveryPlanStore } from "../../infra/storage/json/DiscoveryPlanStore.js";
import type { WorkCycleStore } from "../../infra/storage/json/WorkCycleStore.js";
import type { AlwaysOnRunContextRegistry } from "../shared/RunContextRegistry.js";
import type { SessionConfigOverrides } from "../shared/SessionConfigOverrides.js";
import type { AgentTurnRunner } from "../shared/AgentTurnRunner.js";
import type { PhaseEventEmitter } from "../shared/PhaseEventEmitter.js";

export type ExecutionPhaseDeps = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  runContexts: AlwaysOnRunContextRegistry;
  sessionOverrides: SessionConfigOverrides;
  planStore: DiscoveryPlanStore;
  cycleStore: WorkCycleStore;
  turnRunner: AgentTurnRunner;
  events: PhaseEventEmitter;
  now: () => Date;
  excludeTools: string[];
  permissionRules: PermissionRule[];
};

export type ExecutionPhaseInput = {
  runId: string;
  startedAt: Date;
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspace: WorkspaceHandle;
  cycle: WorkCycleRecord;
  keepSessionOpen?: boolean;
};

export type ExecutionPhaseOutput = {
  sessionKey: string;
  commitShas: string[];
  error?: { code?: string; message: string };
};

export type ExecutionGitState = {
  baseCommit: string;
  beforeHead: string;
};
