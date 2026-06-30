import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReportPhase } from "../../src/always-on/phases/report/index.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/phases/shared/RunContextRegistry.js";
import { SessionConfigOverrides } from "../../src/always-on/phases/shared/SessionConfigOverrides.js";
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
      dedupeKey: "plan-1",
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
    const phase = new ReportPhase({
      config: { language: "en" } as any,
      paths: {} as any,
      projectKey: "/project",
      runContexts: new AlwaysOnRunContextRegistry(),
      sessionOverrides: new SessionConfigOverrides(),
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
        run: async () => [],
        closeSession: async () => undefined,
      } as any,
      events: { emit: () => undefined } as any,
      fallbackWriter: { write: async () => "/reports/fallback.md" } as any,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      excludeTools: [],
    });

    const result = await phase.execute({
      runId: "run-1",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      plan,
      planMarkdown: "# Plan 1",
      workspace,
      cycle,
      executionCommitShas: [],
    });

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
});
