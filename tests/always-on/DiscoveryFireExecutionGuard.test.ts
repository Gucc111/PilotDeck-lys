import assert from "node:assert/strict";
import { it } from "node:test";
import {
  DiscoveryFire,
  type DiscoveryFireDependencies,
} from "../../src/always-on/runtime/DiscoveryFire.js";
import type { DiscoveryPlanRecord } from "../../src/always-on/protocol/types.js";

it("rejects rerunning a completed plan", async () => {
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
  const deps = {
    planStore: {
      getRecord: async () => plan,
    },
  } as unknown as DiscoveryFireDependencies;

  const result = await new DiscoveryFire(deps).rerunPlan({
    planId: plan.id,
    runId: "rerun-1",
    startedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.error?.code, "plan_not_rerunnable");
});
