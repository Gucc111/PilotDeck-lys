import assert from "node:assert/strict";
import { it } from "node:test";
import {
  DiscoveryFire,
  type DiscoveryFireDependencies,
} from "../../src/always-on/runtime/DiscoveryFire.js";
import type {
  DiscoveryPlanRecord,
  WorkCycleExecutionRecord,
} from "../../src/always-on/protocol/types.js";

it("rejects rerunning a plan that already has an execution record", async () => {
  const plan: DiscoveryPlanRecord = {
    id: "plan-1",
    title: "Plan 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    summary: "",
    rationale: "",
    dedupeKey: "plan-1",
    sourceRunId: "run-1",
    planFilePath: "plans/plan-1.md",
    workCycleId: "cycle-1",
  };
  const execution: WorkCycleExecutionRecord = {
    executionId: "execution-1",
    runId: "run-1",
    planId: plan.id,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    baseCommit: "a".repeat(40),
    beforeHead: "b".repeat(40),
    afterHead: "c".repeat(40),
    commitShas: ["d".repeat(40)],
    dependsOnPlanIds: [],
    dependencyReasons: [],
    dependencyAnalysisStatus: "clean",
  };
  const deps = {
    planStore: {
      getRecord: async () => plan,
    },
    cycleStore: {
      findExecutionByPlanId: async () => execution,
    },
  } as unknown as DiscoveryFireDependencies;

  const result = await new DiscoveryFire(deps).rerunPlan({
    planId: plan.id,
    runId: "rerun-1",
    startedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.error?.code, "plan_already_executed");
});
