import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ExecutionPhase } from "../../src/always-on/phases/execution/index.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";
import type { DiscoveryPlanRecord, WorkCycleRecord, WorkspaceHandle } from "../../src/always-on/protocol/types.js";

describe("ExecutionPhase", () => {
  it("returns a git-unavailable error before running the agent when workspace is not a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-execution-phase-"));
    try {
      const projectRoot = join(root, "project");
      const workspaceCwd = join(root, "worktrees", "run-1");
      await mkdir(workspaceCwd, { recursive: true });

      const plan: DiscoveryPlanRecord = {
        id: "plan-1",
        title: "Plan 1",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "ready",
        summary: "",
        rationale: "",
        dedupeKey: "plan-1",
        sourceRunId: "run-1",
        planFilePath: "plans/plan-1.md",
      };
      const workspace: WorkspaceHandle = {
        runId: "run-1",
        projectKey: projectRoot,
        strategy: "snapshot-copy",
        cwd: workspaceCwd,
        metadata: {},
      };
      const cycle: WorkCycleRecord = {
        id: "cycle-1",
        projectKey: projectRoot,
        status: "active",
        baseCommit: "",
        workspace: { strategy: workspace.strategy, cwd: workspace.cwd, metadata: workspace.metadata },
        plans: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByRunId: "run-1",
      };

      let agentRan = false;
      let addPlanCalled = false;
      const phase = new ExecutionPhase({
        config: { language: "en" } as any,
        paths: {} as any,
        projectKey: projectRoot,
        runContexts: new AlwaysOnRunContextRegistry(),
        sessionOverrides: new SessionConfigOverrides(),
        planStore: { updateStatus: async () => undefined } as any,
        cycleStore: {
          addPlan: async () => {
            addPlanCalled = true;
          },
          recordPlanRun: async () => undefined,
          getRecord: async () => cycle,
        } as any,
        turnRunner: {
          run: async () => {
            agentRan = true;
            return [];
          },
          closeSession: async () => undefined,
        } as any,
        events: { emit: () => undefined } as any,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        excludeTools: [],
        permissionRules: [],
      });

      const result = await phase.execute({
        runId: "run-1",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        plan,
        planMarkdown: "# Plan 1",
        workspace,
        cycle,
      });

      assert.equal(addPlanCalled, true);
      assert.equal(agentRan, false);
      assert.equal(result.commitShas.length, 0);
      assert.equal(result.error?.code, "workspace_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
