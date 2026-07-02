import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportPrompt, ReportPhase } from "../../src/always-on/phases/report/index.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/phases/shared/RunContextRegistry.js";
import type { AgentTurnInput } from "../../src/always-on/phases/shared/index.js";
import type { DiscoveryPlanRecord, WorkCycleRecord, WorkspaceHandle } from "../../src/always-on/infra/storage/types.js";

describe("ReportPhase", () => {
  it("writes a fallback report and marks the plan completed_no_report when no report is produced", async () => {
    const plan: DiscoveryPlanRecord = {
      id: "plan-1",
      title: "Plan 1",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "executing",
      summary: "",
      rationale: "",
      sourceRunId: "run-1",
      planFilePath: "plans/plan-1.md",
    };
    const workspace: WorkspaceHandle = {
      runId: "run-1",
      projectKey: "/project",
      strategy: "snapshot-copy",
      cwd: "/workspace",
      metadata: {},
    };
    const cycle: WorkCycleRecord = {
      id: "cycle-1",
      projectKey: "/project",
      status: "active",
      baseCommit: "base",
      workspace: { strategy: workspace.strategy, cwd: workspace.cwd, metadata: workspace.metadata },
      plans: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      createdByRunId: "run-1",
    };

    let updatedStatus: unknown;
    let markedOutcome: unknown;
    let reportTurn: AgentTurnInput | undefined;
    let closedSessionKey = "";
    const executionSessionKey = "always-on/execute:project=/project:run=run-1";
    const phase = new ReportPhase({
      config: { language: "en" } as any,
      paths: {} as any,
      projectKey: "/project",
      runContexts: new AlwaysOnRunContextRegistry(),
      planStore: {
        updateStatus: async (_planId: string, status: unknown) => {
          updatedStatus = status;
        },
      } as any,
      stateStore: {
        markFireCompleted: async (input: unknown) => {
          markedOutcome = input;
        },
      } as any,
      reportStore: {} as any,
      turnRunner: {
        run: async (input: AgentTurnInput) => {
          reportTurn = input;
          return [];
        },
        closeSession: async (sessionKey: string) => {
          closedSessionKey = sessionKey;
        },
      } as any,
      events: { emit: () => undefined } as any,
      fallbackWriter: { write: async () => "/reports/fallback.md" } as any,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    });

    const result = await phase.execute({
      sessionKey: executionSessionKey,
      runId: "run-1",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      plan,
      workspace,
      cycle,
      executionCommitShas: [],
    });

    assert.equal(reportTurn?.sessionKey, executionSessionKey);
    assert.equal(reportTurn?.channelKey, "always-on/report");
    assert.equal(closedSessionKey, executionSessionKey);
    assert.equal(result.planStatus, "completed_no_report");
    assert.equal(result.reportFilePath, "/reports/fallback.md");
    assert.deepEqual(updatedStatus, {
      status: "completed_no_report",
      reportFilePath: "/reports/fallback.md",
      workCycleId: "cycle-1",
    });
    assert.deepEqual(markedOutcome, {
      outcome: "executed",
      runId: "run-1",
      planId: "plan-1",
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
  });

  it("builds report prompts from the existing session context without reinjecting plan or workspace policy text", () => {
    const en = buildReportPrompt({
      executionCommitShas: ["abc123"],
      language: "en",
      planMarkdown: "SENTINEL_PLAN",
      workspaceCwd: "/workspace",
      workspaceStrategy: "snapshot-copy",
    } as any);
    assert.doesNotMatch(en, /Always-On/);
    assert.doesNotMatch(en, /Workspace strategy/);
    assert.doesNotMatch(en, /Workspace cwd/);
    assert.doesNotMatch(en, /Permissions/);
    assert.doesNotMatch(en, /SENTINEL_PLAN/);
    assert.match(en, /plan execution just completed/);

    const zh = buildReportPrompt({
      executionCommitShas: [],
      language: "zh-CN",
      planMarkdown: "SENTINEL_PLAN",
      workspaceCwd: "/workspace",
      workspaceStrategy: "snapshot-copy",
    } as any);
    assert.doesNotMatch(zh, /Always-On/);
    assert.doesNotMatch(zh, /工作区策略/);
    assert.doesNotMatch(zh, /工作区路径/);
    assert.doesNotMatch(zh, /权限/);
    assert.doesNotMatch(zh, /SENTINEL_PLAN/);
    assert.match(zh, /刚完成的计划执行/);
  });
});
