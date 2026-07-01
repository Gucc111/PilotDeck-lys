import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ApplyPhase } from "../../src/always-on/phases/apply/index.js";
import { SessionConfigOverrides } from "../../src/always-on/phases/shared/SessionConfigOverrides.js";
import type { WorkCycleRecord } from "../../src/always-on/infra/storage/types.js";
import {
  commitDirtyWorkspace,
  getHeadCommit,
  initializeTemporaryGitRepository,
  listCommitsBetween,
  runGit,
} from "../../src/always-on/infra/git/index.js";

function makePhase(input: {
  projectKey: string;
  onRun?: (turn: { message: string }) => void;
}) {
  let agentRan = false;
  const phase = new ApplyPhase({
    config: { language: "en" } as any,
    projectKey: input.projectKey,
    sessionOverrides: new SessionConfigOverrides(),
    planStore: { updateStatus: async () => undefined } as any,
    cycleStore: { updatePlanStatus: async () => undefined } as any,
    turnRunner: {
      run: async (turn: { message: string }) => {
        agentRan = true;
        input.onRun?.(turn);
        return [];
      },
      closeSession: async () => undefined,
    } as any,
    events: { emit: () => undefined } as any,
    excludeTools: [],
  });
  return { phase, getAgentRan: () => agentRan };
}

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

  it("applies git project changes programmatically without starting an agent turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-phase-fast-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "file.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(project, "base");
      const clone = await runGit(root, ["clone", project, workspace]);
      assert.equal(clone.exitCode, 0, clone.stderr);

      const before = await getHeadCommit(workspace);
      await writeFile(join(workspace, "file.txt"), "workspace\n", "utf8");
      await commitDirtyWorkspace(workspace, "workspace change");
      const after = await getHeadCommit(workspace);
      const commitShas = await listCommitsBetween(workspace, before, after);

      const cycle = makeCycle(project, workspace, baseCommit, commitShas);
      const { phase, getAgentRan } = makePhase({ projectKey: project });
      const result = await phase.execute({
        runId: "apply-fast",
        cycle,
        plans: [{ id: "plan-1", title: "Plan 1" }],
        planIds: ["plan-1"],
        projectName: "project",
        projectRoot: project,
      });

      assert.equal(result.error, undefined);
      assert.equal(getAgentRan(), false);
      assert.equal(await readFile(join(project, "file.txt"), "utf8"), "workspace\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the agent when programmatic git apply fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-phase-fallback-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "file.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(project, "base");
      const clone = await runGit(root, ["clone", project, workspace]);
      assert.equal(clone.exitCode, 0, clone.stderr);

      const before = await getHeadCommit(workspace);
      await writeFile(join(workspace, "file.txt"), "workspace\n", "utf8");
      await commitDirtyWorkspace(workspace, "workspace change");
      const after = await getHeadCommit(workspace);
      const commitShas = await listCommitsBetween(workspace, before, after);

      await writeFile(join(project, "file.txt"), "project\n", "utf8");
      await commitDirtyWorkspace(project, "project change");

      let prompt = "";
      const cycle = makeCycle(project, workspace, baseCommit, commitShas);
      const { phase, getAgentRan } = makePhase({
        projectKey: project,
        onRun: (turn) => {
          prompt = turn.message;
        },
      });
      const result = await phase.execute({
        runId: "apply-fallback",
        cycle,
        plans: [{ id: "plan-1", title: "Plan 1" }],
        planIds: ["plan-1"],
        allowDivergedProject: true,
        projectName: "project",
        projectRoot: project,
      });

      assert.equal(result.error, undefined);
      assert.equal(getAgentRan(), true);
      assert.match(prompt, /already tried to apply/i);
      assert.match(prompt, /git apply failed/i);
      assert.match(prompt, /Do NOT use git merge/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeCycle(
  projectRoot: string,
  workspaceCwd: string,
  baseCommit: string,
  commitShas: string[],
): WorkCycleRecord {
  return {
    id: "cycle-1",
    projectKey: projectRoot,
    status: "active",
    baseCommit,
    workspace: { strategy: "git-worktree", cwd: workspaceCwd, metadata: { baseCommit } },
    plans: {
      "plan-1": {
        status: "completed",
        commitShas,
        dependsOnPlanIds: [],
        dependencyReasons: [],
        dependencyAnalysisStatus: "clean",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    createdByRunId: "run-1",
  };
}
