import { buildFallbackReport, type ReportMetadata } from "../report/contract/index.js";
import type { DiscoveryPlanRecord } from "../../protocol/types.js";
import type { DiscoveryReportStore } from "../../infra/storage/file/DiscoveryReportStore.js";

export type ReportFallbackWriterDeps = {
  reportStore: DiscoveryReportStore;
};

export class ReportFallbackWriter {
  constructor(private readonly deps: ReportFallbackWriterDeps) {}

  async write(input: {
    runId: string;
    plan: DiscoveryPlanRecord;
    startedAt: string;
    finishedAt: string;
    reason: string;
    workspaceStrategy: string;
    workspaceHandle: string;
  }): Promise<string> {
    const metadata: ReportMetadata = {
      runId: input.runId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: "failed",
      workspaceStrategy: input.workspaceStrategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
      workspaceHandle: input.workspaceHandle,
    };
    const markdown = buildFallbackReport({
      metadata,
      title: input.plan.title,
      reason: input.reason,
    });
    return this.deps.reportStore.writeReport(input.runId, markdown);
  }
}
