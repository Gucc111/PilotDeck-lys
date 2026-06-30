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
  DiscoveryFireResult,
  GateBlockReason,
  GateResult,
  WorkCycleIndex,
  WorkCycleDependencyAnalysisStatus,
  WorkCycleExecutionRecord,
  WorkCycleExecutionStatus,
  WorkCycleRecord,
  WorkCycleStatus,
  WorkspaceHandle,
  WorkspaceStrategyId,
} from "./protocol/types.js";
export { AlwaysOnError, type AlwaysOnErrorCode } from "./protocol/errors.js";
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
  PreferenceExtractor,
  preparePreferenceMemory,
  readPreferences,
  type LoggerLike as PreferenceLoggerLike,
  type PreferenceExtractionInput,
  type PreferenceExtractionResult,
  type PreferenceExtractorDependencies,
  type PreferenceLlmOptions,
  type PreparePreferenceMemoryInput,
} from "./memory/PreferenceExtractor.js";
export {
  parsePlanMarkdown,
  PLAN_REQUIRED_SECTIONS,
  PLAN_METADATA_FIRST_LINE,
  PLAN_METADATA_KEYS,
  type PlanContractOptions,
  type PlanMetadata,
  type PlanParseResult,
} from "./contracts/PlanContract.js";
export {
  parseReportMarkdown,
  buildFallbackReport,
  rebuildReport,
  REPORT_METADATA_FIRST_LINE,
  REPORT_REQUIRED_SECTIONS,
  type ReportMetadata,
  type ReportParseResult,
  type BuildFallbackReportInput,
} from "./contracts/ReportContract.js";
export { ChannelLeaseRegistry, type LeaseUpdateInput } from "./runtime/ChannelLeaseRegistry.js";
export {
  evaluateAlwaysOnDiscoveryGates,
  type DiscoveryGateInput,
} from "./runtime/DiscoveryGates.js";
export { SignalWatcher, type SignalWatcherOptions } from "./runtime/SignalWatcher.js";
export {
  AlwaysOnRunContextRegistry,
  type AlwaysOnRunContext,
  type DiscoveryRunContext,
  type ExecutionRunContext,
  type ReportRunContext,
} from "./runtime/AlwaysOnRunContextRegistry.js";
export {
  SessionConfigOverrides,
  UNATTENDED_SESSION_EXCLUDED_TOOLS,
  type SessionConfigOverride,
} from "./runtime/SessionConfigOverrides.js";
export {
  DiscoveryFire,
  acquireDiscoveryLock,
  releaseDiscoveryLock,
  type DiscoveryFireDependencies,
  type DiscoveryFireRunInput,
} from "./runtime/DiscoveryFire.js";
export {
  DiscoveryScheduler,
  type DiscoverySchedulerDependencies,
  type DiscoverySchedulerLogger,
} from "./runtime/DiscoveryScheduler.js";
export {
  AlwaysOnRuntime,
  createAlwaysOnRuntime,
  type AlwaysOnRuntimeLogger,
  type CreateAlwaysOnRuntimeOptions,
} from "./runtime/AlwaysOnRuntime.js";
export {
  AlwaysOnManager,
  createAlwaysOnManager,
  type CreateAlwaysOnManagerOptions,
} from "./runtime/AlwaysOnManager.js";
export {
  buildDiscoveryPrompt,
  buildExecutionPrompt,
  buildReportPrompt,
  buildApplyPrompt,
  type BuildDiscoveryPromptInput,
  type BuildExecutionPromptInput,
  type BuildReportPromptInput,
  type BuildApplyPromptInput,
} from "./runtime/discoveryPrompts.js";
export { DiscoveryPhase, type DiscoveryPhaseDeps, type DiscoveryPhaseInput, type DiscoveryPhaseOutput } from "./phases/discovery/index.js";
export { WorkspacePhase, type WorkspacePhaseDeps, type WorkspacePhaseInput, type WorkspacePhaseOutput } from "./phases/workspace/index.js";
export { ExecutionPhase, type ExecutionPhaseDeps, type ExecutionPhaseInput, type ExecutionPhaseOutput } from "./phases/execution/index.js";
export { ReportPhase, type ReportPhaseDeps, type ReportPhaseInput, type ReportPhaseOutput } from "./phases/report/index.js";
export { ApplyPhase, type ApplyPhaseDeps, type ApplyPhaseInput, type ApplyPhaseOutput } from "./phases/apply/index.js";
export {
  AgentTurnRunner,
  AlwaysOnFailurePolicy,
  PhaseEventEmitter,
  ReportFallbackWriter,
} from "./phases/shared/index.js";
export {
  createAlwaysOnDiscoveryPlanTool,
  ALWAYS_ON_PLAN_TOOL_NAME,
  type AlwaysOnDiscoveryPlanInput,
  type AlwaysOnDiscoveryPlanOutput,
  type CreateAlwaysOnDiscoveryPlanToolOptions,
} from "./tool/AlwaysOnDiscoveryPlanTool.js";
export {
  createAlwaysOnReportTool,
  ALWAYS_ON_REPORT_TOOL_NAME,
  type AlwaysOnReportInput,
  type AlwaysOnReportOutput,
  type CreateAlwaysOnReportToolOptions,
} from "./tool/AlwaysOnReportTool.js";
export { createApplyHandler, type CreateApplyHandlerDeps } from "./runtime/createApplyHandler.js";
export type { WorkspaceProvider, WorkspaceProviderId, WorkspacePrepareInput, WorkspacePublishOutput } from "./workspace/WorkspaceProvider.js";

// Web-facing presentation & lifecycle services (shared by UI/CLI/SDK)
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
export { DiscoveryPlanService, normalizeDiscoveryPlanRecord, type DiscoveryPlanServiceDeps, type StateManager } from "./web/DiscoveryPlanService.js";
export { buildDiscoveryContext, type DiscoveryContextDeps } from "./web/DiscoveryPlanContext.js";
export { GitWorktreeProvider, type GitWorktreeProviderOptions } from "./workspace/GitWorktreeProvider.js";
export { SnapshotCopyProvider, type SnapshotCopyProviderOptions } from "./workspace/SnapshotCopyProvider.js";
export { WorkspaceProviderRegistry } from "./workspace/WorkspaceProviderRegistry.js";
