import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
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
} from "../../src/always-on/workspace/WorkspaceGit.js";

it("builds commit-scoped apply prompts without including unselected plan changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-apply-prompt-"));
  const workspace = join(root, "workspace");
  const projectRoot = join(root, "project");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
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

    const cycle: WorkCycleRecord = {
      id: "cycle-1",
      projectKey: projectRoot,
      status: "active",
      workspace: {
        strategy: "snapshot-copy",
        cwd: workspace,
        metadata: { baseCommit },
      },
      planIds: ["a", "b"],
      executions: [
        {
          executionId: "execution-a",
          runId: "run-a",
          planId: "a",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z",
          baseCommit,
          beforeHead: beforeA,
          afterHead: afterA,
          commitShas: planACommits,
          dependsOnPlanIds: [],
          dependencyReasons: [],
          dependencyAnalysisStatus: "clean",
        },
        {
          executionId: "execution-b",
          runId: "run-b",
          planId: "b",
          status: "completed",
          startedAt: "2026-01-01T00:02:00.000Z",
          finishedAt: "2026-01-01T00:03:00.000Z",
          baseCommit,
          beforeHead: beforeB,
          afterHead: afterB,
          commitShas: planBCommits,
          dependsOnPlanIds: [],
          dependencyReasons: [],
          dependencyAnalysisStatus: "clean",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdByRunId: "run-a",
    };

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
      reportStore: {
        appendRunEvent: async () => undefined,
      },
      uuid: () => "uuid",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as unknown as DiscoveryFireDependencies;

    const result = await new DiscoveryFire(deps).runApplyPhase({
      runId: "apply-1",
      cycle,
      plans: [{ id: "a", title: "Plan A" }],
      planIds: ["a"],
      projectName: "project",
      projectRoot,
    });

    assert.equal(result.error, undefined);
    assert.match(prompt, /plan-a\.txt/);
    assert.doesNotMatch(prompt, /plan-b\.txt/);
    assert.match(prompt, /Do not merge the isolated workspace branch/);
    assert.doesNotMatch(prompt, /Workspace branch:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
