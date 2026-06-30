export type {
  AlwaysOnCurrentWorkspaceRef,
  AlwaysOnDiscoveryOutcome,
  AlwaysOnDiscoveryState,
  AlwaysOnDormantState,
  AlwaysOnChannelLease,
  AlwaysOnEventPhase,
  AlwaysOnPhaseEvent,
  PreferenceEvent,
  PreferenceEventPlan,
  PreferencePlanOutcome,
  DiscoveryPlanIndex,
  DiscoveryPlanRecord,
  DiscoveryPlanStatus,
  DiscoveryPlanWorkspaceRef,
  WorkCycleIndex,
  WorkCycleDependencyAnalysisStatus,
  WorkCycleExecutionRecord,
  WorkCycleExecutionStatus,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
  WorkspaceStrategyId,
} from "./infra/storage/types.js";
export type { AlwaysOnPipelineResult, GateBlockReason, GateResult } from "./orchestration/types.js";
export { AlwaysOnError, type AlwaysOnErrorCode } from "./infra/errors.js";
export {
  parseAlwaysOnConfig,
  defaultAlwaysOnConfig,
  DEFAULT_IGNORE_GLOBS,
  type AlwaysOnConfig,
  type AlwaysOnPromptLanguage,
  type AlwaysOnDormancyConfig,
  type AlwaysOnMemoryConfig,
  type AlwaysOnProjectConfig,
  type AlwaysOnTriggerConfig,
  type AlwaysOnWorkspaceConfig,
} from "./infra/config/index.js";
export {
  resolveAlwaysOnPaths,
  planMarkdownPath,
  reportMarkdownPath,
  type AlwaysOnPaths,
} from "./infra/storage/AlwaysOnPaths.js";
export { DiscoveryStateStore, defaultDiscoveryState, getDayKey } from "./infra/storage/json/DiscoveryStateStore.js";
export { DiscoveryPlanStore } from "./infra/storage/json/DiscoveryPlanStore.js";
export { WorkCycleStore } from "./infra/storage/json/WorkCycleStore.js";
export { DiscoveryReportStore } from "./infra/storage/file/DiscoveryReportStore.js";
export { AlwaysOnEventStore } from "./infra/storage/log/AlwaysOnEventStore.js";
export { PreferenceEventStore } from "./infra/storage/log/PreferenceEventStore.js";
export {
  readPreferences,
  type LoggerLike as PreferenceLoggerLike,
  type PreferenceLlmOptions,
} from "./phases/discovery/memory/index.js";
export {
  SessionConfigOverrides,
  type SessionConfigOverride,
} from "./phases/shared/SessionConfigOverrides.js";
export {
  AlwaysOnRuntime,
  createAlwaysOnRuntime,
  type AlwaysOnRuntimeLogger,
  type CreateAlwaysOnRuntimeOptions,
} from "./app/AlwaysOnRuntime.js";
export {
  AlwaysOnManager,
  createAlwaysOnManager,
  type CreateAlwaysOnManagerOptions,
} from "./app/AlwaysOnManager.js";
export { createApplyHandler, type CreateApplyHandlerDeps } from "./app/createApplyHandler.js";
export {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  toTimestampValue,
  toIsoTimestamp,
  pickLatestIsoTimestamp,
  normalizeString as webNormalizeString,
  truncateText,
  normalizeStringList,
  PLAN_STATUS_ORDER,
  type WebCycleRecord,
  type WebPlanRecord,
  type WebPlanSession,
  type WebPlanContextRefs,
  type WebPlanStatus,
} from "./web/DiscoveryPlanStatus.js";
export {
  DiscoveryPlanService,
  normalizeDiscoveryPlanRecord,
  type DiscoveryPlanServiceDeps,
  type PlanLifecycleActions,
  type StateManager,
} from "./web/DiscoveryPlanService.js";
export { buildDiscoveryContext, type DiscoveryContextDeps } from "./web/DiscoveryPlanContext.js";
