import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  DiscoveryFire,
  type DiscoveryFireDependencies,
} from "../../src/always-on/runtime/DiscoveryFire.js";
import type { WorkCycleRecord } from "../../src/always-on/protocol/types.js";
import {
  commitDirtyWorkspace,
  getHeadCommit,
  initializeTemporaryGitRepository,
  listCommitsBetween,
  runGit,
} from "../../src/always-on/workspace/WorkspaceGit.js";

function makeDeps(
  projectRoot: string,
  overrides?: Partial<DiscoveryFireDependencies>,
): { deps: DiscoveryFireDependencies; getPrompt: () => string } {
  let prompt = "";
  const deps = {
    config: { language: "en" },
    projectKey: projectRoot,
    gateway: {
      async *submitTurn(input: { message: string }) {
        prompt = input.message;
        yield { type: "assistant_text_delta", text: "applied" };
      },
      closeSession: async () => undefined,
    },
    sessionOverrides: {
      set: () => undefined,
      delete: () => undefined,
    },
    eventStore: {
      appendEvent: async () => undefined,
    },
    cycleStore: {
      updatePlanStatus: async () => undefined,
    },
    planStore: {
      updateStatus: async () => undefined,
    },
    uuid: () => "uuid",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as DiscoveryFireDependencies;
  return { deps, getPrompt: () => prompt };
}

async function setupThreePlanWorkspace(root: string) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
  const baseCommit = await initializeTemporaryGitRepository(workspace, "base");

  const beforeA = await getHeadCommit(workspace);
  await writeFile(join(workspace, "plan-a.txt"), "only plan A\n", "utf8");
  await commitDirtyWorkspace(workspace, "plan A");
  const afterA = await getHeadCommit(workspace);
  const planACommits = await listCommitsBetween(workspace, beforeA, afterA);

  const beforeB = await getHeadCommit(workspace);
  await writeFile(join(workspace, "plan-b.txt"), "only plan B\n", "utf8");
  await commitDirtyWorkspace(workspace, "plan B");
  const afterB = await getHeadCommit(workspace);
  const planBCommits = await listCommitsBetween(workspace, beforeB, afterB);

  const beforeC = await getHeadCommit(workspace);
  await writeFile(join(workspace, "plan-c.txt"), "only plan C\n", "utf8");
  await commitDirtyWorkspace(workspace, "plan C");
  const afterC = await getHeadCommit(workspace);
  const planCCommits = await listCommitsBetween(workspace, beforeC, afterC);

  return {
    workspace,
    baseCommit,
    planA: { beforeHead: beforeA, afterHead: afterA, commitShas: planACommits },
    planB: { beforeHead: beforeB, afterHead: afterB, commitShas: planBCommits },
    planC: { beforeHead: beforeC, afterHead: afterC, commitShas: planCCommits },
  };
}

function buildCycle(
  projectRoot: string,
  workspace: string,
  baseCommit: string,
  plans: Record<string, { beforeHead: string; afterHead: string; commitShas: string[]; status?: string }>,
): WorkCycleRecord {
  const planEntries: WorkCycleRecord["plans"] = {};
  for (const [id, p] of Object.entries(plans)) {
    planEntries[id] = {
      status: p.status ?? "completed",
      beforeHead: p.beforeHead,
      afterHead: p.afterHead,
      commitShas: p.commitShas,
      dependsOnPlanIds: [],
      dependencyReasons: [],
      dependencyAnalysisStatus: "clean",
      lastRunId: `run-${id}`,
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
  }
  return {
    id: "cycle-1",
    projectKey: projectRoot,
    status: "active",
    baseCommit,
    workspace: { strategy: "snapshot-copy", cwd: workspace, metadata: { baseCommit } },
    plans: planEntries,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdByRunId: "run-init",
  };
}

describe("runApplyPhase", () => {
  it("archives unselected plans and excludes their changes from the cumulative diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-archive-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    try {
      const setup = await setupThreePlanWorkspace(root);
      const cycle = buildCycle(projectRoot, setup.workspace, setup.baseCommit, {
        a: setup.planA,
        b: setup.planB,
        c: setup.planC,
      });

      const archivedPlanIds: string[] = [];
      const { deps, getPrompt } = makeDeps(projectRoot, {
        cycleStore: {
          updatePlanStatus: async (_cycleId: string, planId: string, status: string) => {
            if (status === "archived") archivedPlanIds.push(planId);
          },
        },
        planStore: {
          updateStatus: async () => undefined,
        },
      } as unknown as Partial<DiscoveryFireDependencies>);

      const result = await new DiscoveryFire(deps).runApplyPhase({
        runId: "apply-archive",
        cycle,
        plans: [
          { id: "a", title: "Plan A" },
          { id: "c", title: "Plan C" },
        ],
        planIds: ["a", "c"],
        projectName: "project",
        projectRoot,
      });

      assert.equal(result.error, undefined);
      const prompt = getPrompt();

      assert.match(prompt, /plan-a\.txt/, "should contain plan A file");
      assert.doesNotMatch(prompt, /plan-b\.txt/, "should NOT contain plan B file (archived)");
      assert.match(prompt, /plan-c\.txt/, "should contain plan C file");

      assert.deepStrictEqual(archivedPlanIds.sort(), ["b"], "plan b should be archived");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates non-git prompt when projectRoot is not a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-nongit-"));
    const projectRoot = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });

    try {
      await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(workspace, "base");

      const beforeA = await getHeadCommit(workspace);
      await writeFile(join(workspace, "new-file.txt"), "hello\n", "utf8");
      await commitDirtyWorkspace(workspace, "add file");
      const afterA = await getHeadCommit(workspace);
      const commitShas = await listCommitsBetween(workspace, beforeA, afterA);

      const cycle = buildCycle(projectRoot, workspace, baseCommit, {
        a: { beforeHead: beforeA, afterHead: afterA, commitShas },
      });

      const { deps, getPrompt } = makeDeps(projectRoot);

      const result = await new DiscoveryFire(deps).runApplyPhase({
        runId: "apply-nongit",
        cycle,
        plans: [{ id: "a", title: "Plan A" }],
        planIds: ["a"],
        projectName: "project",
        projectRoot,
      });

      assert.equal(result.error, undefined);
      const prompt = getPrompt();

      assert.match(prompt, /not a git repository/i, "should mention not a git repository");
      assert.match(prompt, /Read .* Write/i, "should suggest Read/Write tools");
      assert.doesNotMatch(prompt, /git apply/, "should NOT suggest git apply");
      assert.doesNotMatch(prompt, /git merge/, "should NOT suggest git merge");
      assert.doesNotMatch(prompt, /git cherry-pick/, "should NOT suggest cherry-pick");

      assert.match(prompt, /\[Added\].*new-file\.txt/, "should list the added file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates git-aware prompt when projectRoot is a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-git-"));
    const projectRoot = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });

    try {
      await writeFile(join(projectRoot, "init.txt"), "init\n", "utf8");
      await initializeTemporaryGitRepository(projectRoot, "init project");

      await writeFile(join(workspace, "base.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(workspace, "base");

      const beforeA = await getHeadCommit(workspace);
      await writeFile(join(workspace, "feature.txt"), "feature\n", "utf8");
      await commitDirtyWorkspace(workspace, "add feature");
      const afterA = await getHeadCommit(workspace);
      const commitShas = await listCommitsBetween(workspace, beforeA, afterA);

      const cycle = buildCycle(projectRoot, workspace, baseCommit, {
        a: { beforeHead: beforeA, afterHead: afterA, commitShas },
      });

      const { deps, getPrompt } = makeDeps(projectRoot);

      const result = await new DiscoveryFire(deps).runApplyPhase({
        runId: "apply-git",
        cycle,
        plans: [{ id: "a", title: "Plan A" }],
        planIds: ["a"],
        projectName: "project",
        projectRoot,
      });

      assert.equal(result.error, undefined);
      const prompt = getPrompt();

      assert.match(prompt, /git apply/, "should suggest git apply");
      assert.match(prompt, /Do NOT commit/i, "should warn against committing");
      assert.match(prompt, /Do NOT use git merge/i, "should warn against git merge");
      assert.match(prompt, /Do NOT use.*git cherry-pick/i, "should warn against cherry-pick");
      assert.match(prompt, /Do NOT use.*git am/i, "should warn against git am");
      assert.doesNotMatch(prompt, /Common approaches/, "should NOT show generic merge approaches");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters only active (non-applied, non-archived) plans for archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-filter-"));
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });

    try {
      const setup = await setupThreePlanWorkspace(root);
      const cycle = buildCycle(projectRoot, setup.workspace, setup.baseCommit, {
        a: setup.planA,
        b: { ...setup.planB, status: "archived" },
        c: setup.planC,
      });

      const archivedPlanIds: string[] = [];
      const { deps, getPrompt } = makeDeps(projectRoot, {
        cycleStore: {
          updatePlanStatus: async (_cycleId: string, planId: string, status: string) => {
            if (status === "archived") archivedPlanIds.push(planId);
          },
        },
        planStore: {
          updateStatus: async () => undefined,
        },
      } as unknown as Partial<DiscoveryFireDependencies>);

      const result = await new DiscoveryFire(deps).runApplyPhase({
        runId: "apply-filter",
        cycle,
        plans: [{ id: "a", title: "Plan A" }],
        planIds: ["a"],
        projectName: "project",
        projectRoot,
      });

      assert.equal(result.error, undefined);
      assert.deepStrictEqual(archivedPlanIds.sort(), ["c"], "only plan c (active & unselected) should be archived");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
