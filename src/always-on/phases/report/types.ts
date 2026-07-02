import type {
  AlwaysOnDiscoveryOutcome,
  DiscoveryPlanRecord,
  DiscoveryPlanStatus,
  WorkCycleRecord,
  WorkspaceHandle,
} from "../../infra/storage/types.js";
import type { AlwaysOnConfig } from "../../infra/config/index.js";
import type { AlwaysOnPaths } from "../../infra/storage/AlwaysOnPaths.js";
import type { DiscoveryPlanStore } from "../../infra/storage/json/DiscoveryPlanStore.js";
import type { DiscoveryReportStore } from "../../infra/storage/file/DiscoveryReportStore.js";
import type { DiscoveryStateStore } from "../../infra/storage/json/DiscoveryStateStore.js";
import type { AlwaysOnRunContextRegistry } from "../shared/RunContextRegistry.js";
import type { AgentTurnRunner } from "../shared/AgentTurnRunner.js";
import type { PhaseEventEmitter } from "../shared/PhaseEventEmitter.js";
import type { ReportFallbackWriter } from "../shared/ReportFallbackWriter.js";

export type ReportPhaseDeps = {
  config: AlwaysOnConfig;
  paths: AlwaysOnPaths;
  projectKey: string;
  runContexts: AlwaysOnRunContextRegistry;
  planStore: DiscoveryPlanStore;
  stateStore: DiscoveryStateStore;
  reportStore: DiscoveryReportStore;
  turnRunner: AgentTurnRunner;
  events: PhaseEventEmitter;
  fallbackWriter: ReportFallbackWriter;
  now: () => Date;
};

export type ReportPhaseInput = {
  sessionKey: string;
  runId: string;
  startedAt: Date;
  plan: DiscoveryPlanRecord;
  workspace: WorkspaceHandle;
  cycle: WorkCycleRecord;
  executionCommitShas: string[];
};

export type ReportPhaseOutput = {
  outcome: AlwaysOnDiscoveryOutcome;
  finishedAt: Date;
  planStatus: DiscoveryPlanStatus;
  reportFilePath?: string;
  error?: { code: string; message: string };
};
