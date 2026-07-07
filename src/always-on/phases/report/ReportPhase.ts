import type { GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import { parseReportMarkdown, type ReportMetadata } from "./contract/index.js";
import type { ReportRunContext } from "../shared/RunContextRegistry.js";
import {
  extractAssistantText,
  pickFirstError,
} from "../shared/index.js";
import { buildReportPrompt } from "./prompts.js";
import type { ReportPhaseDeps, ReportPhaseInput, ReportPhaseOutput } from "./types.js";

const REPORT_CHANNEL: GatewayChannelKey = "always-on/report";

export class ReportPhase {
  constructor(private readonly deps: ReportPhaseDeps) {}

  async execute(input: ReportPhaseInput): Promise<ReportPhaseOutput> {
    const { plan, runId, sessionKey, workspace } = input;
    this.deps.events.emit(runId, "report_started", { planId: plan.id, title: plan.title });

    const reportCtx: ReportRunContext = {
      kind: "report",
      sessionKey,
      runId,
      projectKey: this.deps.projectKey,
      paths: this.deps.paths,
      workspace,
      plan,
      reportStore: this.deps.reportStore,
      reportCallCount: 0,
    };
    this.deps.runContexts.register(reportCtx);

    let reportEvents: GatewayEvent[] = [];
    let reportError: { code?: string; message: string } | undefined;
    try {
      reportEvents = await this.deps.turnRunner.run({
        sessionKey,
        channelKey: REPORT_CHANNEL,
        runId: `${runId}.report`,
        message: buildReportPrompt({
          executionCommitShas: input.executionCommitShas,
          language: this.deps.config.language,
        }),
        mode: "bypassPermissions",
      });
      reportError = pickFirstError(reportEvents);
    } finally {
      this.deps.runContexts.unregister(sessionKey);
      await this.deps.turnRunner.closeSession(sessionKey);
    }

    const finishedAt = this.deps.now();
    if (!reportCtx.report) {
      const assistantText = extractAssistantText(reportEvents);
      if (assistantText) {
        const metadata: ReportMetadata = {
          runId,
          planId: plan.id,
          startedAt: input.startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome: "executed",
          workspaceStrategy: workspace.strategy === "git-worktree" ? "git-worktree" : "snapshot-copy",
          workspaceHandle: workspace.cwd,
        };
        const parsed = parseReportMarkdown(assistantText, metadata);
        const filePath = await this.deps.reportStore.writeReport(runId, parsed.rawContent);
        reportCtx.report = { markdown: parsed.rawContent, filePath, finishedAt };
      }
    }

    const reportDegraded = !reportCtx.report || !!reportError;
    const outcome = "executed" as const;
    const planStatus = reportDegraded ? "completed_no_report" as const : "completed" as const;

    if (!reportDegraded) {
      this.deps.events.emit(runId, "report_produced", { planId: plan.id, title: plan.title, outcome });
    }
    this.deps.events.emit(runId, "run_completed", { planId: plan.id, title: plan.title, outcome });

    let reportFilePath = reportCtx.report?.filePath;
    if (!reportCtx.report) {
      reportFilePath = await this.deps.fallbackWriter.write({
        runId,
        plan,
        startedAt: input.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        reason: reportError ? `report_failed: ${reportError.message}` : "report_tool_not_invoked",
        workspaceStrategy: workspace.strategy,
        workspaceHandle: workspace.cwd,
      });
    }

    await this.deps.cycleStore.updatePlanStatus(input.cycle.id, plan.id, planStatus);
    await this.deps.planStore.updatePlanFields(plan.id, {
      reportFilePath,
      workCycleId: input.cycle.id,
    });
    await this.deps.stateStore.markFireCompleted({
      outcome,
      runId,
      planId: plan.id,
      now: finishedAt,
    });

    return {
      outcome,
      finishedAt,
      planStatus,
      reportFilePath,
      error: reportError
        ? { code: reportError.code ?? "report_degraded", message: reportError.message }
        : undefined,
    };
  }
}
