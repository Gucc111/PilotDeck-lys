import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplyPhase } from "../../src/always-on/phases/apply/index.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";
import type { WorkCycleRecord } from "../../src/always-on/protocol/types.js";

describe("ApplyPhase", () => {
  it("rejects a cycle with failed dependency analysis before starting an agent turn", async () => {
    const cycle: WorkCycleRecord = {
      id: "cycle-1",
      projectKey: "/project",
      status: "active",
      baseCommit: "base",
      workspace: { strategy: "snapshot-copy", cwd: "/workspace", metadata: { baseCommit: "base" } },
      plans: {
        "plan-1": {
          status: "completed",
          commitShas: ["abc"],
          dependsOnPlanIds: [],
          dependencyReasons: ["analysis failed"],
          dependencyAnalysisStatus: "failed",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      createdByRunId: "run-1",
    };

    let agentRan = false;
    const phase = new ApplyPhase({
      config: { language: "en" } as any,
      projectKey: "/project",
      sessionOverrides: new SessionConfigOverrides(),
      planStore: { updateStatus: async () => undefined } as any,
      cycleStore: { updatePlanStatus: async () => undefined } as any,
      turnRunner: {
        run: async () => {
          agentRan = true;
          return [];
        },
        closeSession: async () => undefined,
      } as any,
      events: { emit: () => undefined } as any,
      excludeTools: [],
    });

    const result = await phase.execute({
      runId: "apply-1",
      cycle,
      plans: [{ id: "plan-1", title: "Plan 1" }],
      projectName: "project",
      projectRoot: "/project",
    });

    assert.equal(agentRan, false);
    assert.equal(result.sessionKey, "");
    assert.equal(result.error?.code, "dependency_analysis_failed");
  });
});
