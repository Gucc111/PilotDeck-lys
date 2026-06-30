import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkspacePhase } from "../../src/always-on/phases/workspace/index.js";
import type { WorkCycleRecord } from "../../src/always-on/protocol/types.js";

describe("WorkspacePhase", () => {
  it("reuses an active cycle with an existing workspace directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-phase-"));
    try {
      const projectRoot = join(root, "project");
      const worktreesDir = join(root, "worktrees");
      const snapshotsDir = join(root, "snapshots");
      const workspaceCwd = join(worktreesDir, "run-1");
      await mkdir(workspaceCwd, { recursive: true });

      const cycle: WorkCycleRecord = {
        id: "cycle-1",
        projectKey: projectRoot,
        status: "active",
        baseCommit: "base",
        workspace: {
          strategy: "git-worktree",
          cwd: workspaceCwd,
          metadata: { baseCommit: "base" },
        },
        plans: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByRunId: "run-original",
      };

      let prepareCalled = false;
      const phase = new WorkspacePhase({
        projectKey: projectRoot,
        paths: { worktreesDir, snapshotsDir } as any,
        workspaceRegistry: {
          prepare: async () => {
            prepareCalled = true;
            throw new Error("should not prepare");
          },
        } as any,
        stateStore: { setActiveWorkCycleId: async () => undefined } as any,
        cycleStore: { getRecord: async () => cycle } as any,
        events: { emit: () => undefined } as any,
        uuid: () => "cycle-new",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });

      const result = await phase.execute({
        runId: "run-2",
        state: {
          schemaVersion: 1,
          todayKey: "2026-01-01",
          todayRunCount: 0,
          consecutiveFailures: 0,
          activeWorkCycleId: cycle.id,
        },
        planId: "plan-1",
        planTitle: "Plan",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      assert.equal(prepareCalled, false);
      assert.equal(result.handle.cwd, workspaceCwd);
      assert.equal(result.handle.runId, "run-original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace outside configured Always-On bases", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-phase-invalid-"));
    try {
      const projectRoot = join(root, "project");
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      const phase = new WorkspacePhase({
        projectKey: projectRoot,
        paths: {
          worktreesDir: join(root, "worktrees"),
          snapshotsDir: join(root, "snapshots"),
        } as any,
        workspaceRegistry: {
          prepare: async () => ({
            handle: {
              runId: "run-1",
              projectKey: projectRoot,
              strategy: "snapshot-copy",
              cwd: outside,
              metadata: {},
            },
          }),
        } as any,
        stateStore: { setActiveWorkCycleId: async () => undefined } as any,
        cycleStore: {
          create: async (handle: any) => ({
            id: "cycle-1",
            projectKey: projectRoot,
            status: "active",
            baseCommit: "",
            workspace: { strategy: handle.strategy, cwd: handle.cwd, metadata: handle.metadata },
            plans: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            createdByRunId: "run-1",
          }),
        } as any,
        events: { emit: () => undefined } as any,
        uuid: () => "cycle-1",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });

      await assert.rejects(
        () => phase.execute({
          runId: "run-1",
          state: {
            schemaVersion: 1,
            todayKey: "2026-01-01",
            todayRunCount: 0,
            consecutiveFailures: 0,
          },
          planId: "plan-1",
          planTitle: "Plan",
        }),
        /outside the configured Always-On workspace bases/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
