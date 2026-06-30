import type { DiscoveryPlanRecord, WorkspaceHandle } from "../../infra/storage/types.js";
import type { DiscoveryPlanStore } from "../../infra/storage/json/DiscoveryPlanStore.js";
import type { DiscoveryReportStore } from "../../infra/storage/file/DiscoveryReportStore.js";
import type { AlwaysOnPaths } from "../../infra/storage/AlwaysOnPaths.js";

export type DiscoveryRunContext = {
  kind: "discovery";
  sessionKey: string;
  runId: string;
  projectKey: string;
  paths: AlwaysOnPaths;
  startedAt: Date;
  planStore: DiscoveryPlanStore;
  /** Set after the plan tool succeeds. */
  plan?: { record: DiscoveryPlanRecord; markdown: string };
  /** Number of plan-tool calls in this fire (success and failure). */
  planCallCount: number;
  /** Short alias -> real sessionId mapping for the chat history tool. */
  chatSessionAliases?: Map<string, string>;
};

export type ExecutionRunContext = {
  kind: "execution";
  sessionKey: string;
  runId: string;
  projectKey: string;
  paths: AlwaysOnPaths;
  workspace: WorkspaceHandle;
  plan: DiscoveryPlanRecord;
};

export type ReportRunContext = {
  kind: "report";
  sessionKey: string;
  runId: string;
  projectKey: string;
  paths: AlwaysOnPaths;
  workspace: WorkspaceHandle;
  plan: DiscoveryPlanRecord;
  reportStore: DiscoveryReportStore;
  reportCallCount: number;
  /** Set after the first successful report tool call. */
  report?: { markdown: string; filePath: string; finishedAt: Date };
};

export type AlwaysOnRunContext =
  | DiscoveryRunContext
  | ExecutionRunContext
  | ReportRunContext;

/**
 * Single-process, mutable registry that maps `sessionKey` -> in-flight
 * Always-On run context. Always-On tools query this registry to locate the
 * current run; the runtime registers contexts before submitting a turn and
 * unregisters once the turn settles.
 */
export class AlwaysOnRunContextRegistry {
  private readonly contexts = new Map<string, AlwaysOnRunContext>();

  register(ctx: AlwaysOnRunContext): void {
    if (this.contexts.has(ctx.sessionKey)) {
      throw new Error(`AlwaysOn run context already exists for sessionKey: ${ctx.sessionKey}`);
    }
    this.contexts.set(ctx.sessionKey, ctx);
  }

  unregister(sessionKey: string): void {
    this.contexts.delete(sessionKey);
  }

  get(sessionKey: string): AlwaysOnRunContext | undefined {
    return this.contexts.get(sessionKey);
  }

  getDiscovery(sessionKey: string): DiscoveryRunContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx && ctx.kind === "discovery" ? ctx : undefined;
  }

  getExecution(sessionKey: string): ExecutionRunContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx && ctx.kind === "execution" ? ctx : undefined;
  }

  getReport(sessionKey: string): ReportRunContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx && ctx.kind === "report" ? ctx : undefined;
  }

  list(): AlwaysOnRunContext[] {
    return Array.from(this.contexts.values());
  }
}
