import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  analyzeExecutionDependencies,
  checkApplyProjectReadiness,
  commitDirtyWorkspace,
  generateChangedFileList,
  generatePatchForCommits,
  getHeadCommit,
  getStatusPorcelain,
  initializeTemporaryGitRepository,
  listCommitsBetween,
  runGit,
} from "../../src/always-on/infra/git/index.js";
import { SnapshotCopyProvider } from "../../src/always-on/phases/workspace/SnapshotCopyProvider.js";

async function commitAll(cwd: string, message: string): Promise<string> {
  const add = await runGit(cwd, ["add", "-A"]);
  assert.equal(add.exitCode, 0, add.stderr);
  const commit = await runGit(cwd, [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-m", message,
  ]);
  assert.equal(commit.exitCode, 0, commit.stderr);
  return getHeadCommit(cwd);
}

describe("infra git operations", () => {
  it("initializes snapshot-copy workspaces as git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-provider-"));
    const source = join(root, "source");
    const snapshots = join(root, "snapshots");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "file.txt"), "snapshot\n", "utf8");

      const provider = new SnapshotCopyProvider({
        baseDir: snapshots,
        maxBytes: 1024 * 1024,
      });
      const handle = await provider.prepare({
        projectRoot: source,
        runId: "run-1",
        planTitle: "snapshot plan",
      });

      assert.match(handle.metadata.baseCommit ?? "", /^[0-9a-f]{40}$/);
      assert.equal(await getStatusPorcelain(handle.cwd), "");
      assert.equal(await readFile(join(handle.cwd, "file.txt"), "utf8"), "snapshot\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes a snapshot repository and captures agent plus fallback commits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-git-"));
    try {
      await writeFile(join(cwd, "file.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(cwd, "base");

      await writeFile(join(cwd, "file.txt"), "agent one\n", "utf8");
      await commitAll(cwd, "agent one");
      await writeFile(join(cwd, "second.txt"), "agent two\n", "utf8");
      await commitAll(cwd, "agent two");
      await writeFile(join(cwd, "fallback.txt"), "fallback\n", "utf8");
      const fallback = await commitDirtyWorkspace(cwd, "fallback");

      assert.equal(fallback.committed, true);
      assert.equal(await getStatusPorcelain(cwd), "");
      const commits = await listCommitsBetween(cwd, baseCommit, await getHeadCommit(cwd));
      assert.equal(commits.length, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("generates replayable binary, rename, and deletion patches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-patch-"));
    try {
      await writeFile(join(cwd, "rename-me.txt"), "rename\n", "utf8");
      await writeFile(join(cwd, "delete-me.txt"), "delete\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(cwd, "base");

      await rename(join(cwd, "rename-me.txt"), join(cwd, "renamed.txt"));
      await rm(join(cwd, "delete-me.txt"));
      await writeFile(join(cwd, "image.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 4]));
      await commitDirtyWorkspace(cwd, "complex changes");

      const commits = await listCommitsBetween(cwd, baseCommit, await getHeadCommit(cwd));
      const patch = await generatePatchForCommits(cwd, commits);
      assert.match(patch, /rename from rename-me\.txt/);
      assert.match(patch, /rename to renamed\.txt/);
      assert.match(patch, /deleted file mode/);
      assert.match(patch, /GIT binary patch|Binary files/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("finds direct and transitive dependencies and removes scratch worktrees", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-deps-"));
    try {
      await writeFile(join(cwd, "file.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(cwd, "base");

      const beforeA = await getHeadCommit(cwd);
      await writeFile(join(cwd, "file.txt"), "plan A\n", "utf8");
      await commitDirtyWorkspace(cwd, "plan A");
      const aCommits = await listCommitsBetween(cwd, beforeA, await getHeadCommit(cwd));

      const beforeB = await getHeadCommit(cwd);
      await writeFile(join(cwd, "file.txt"), "plan B\n", "utf8");
      await commitDirtyWorkspace(cwd, "plan B");
      const bCommits = await listCommitsBetween(cwd, beforeB, await getHeadCommit(cwd));

      const beforeC = await getHeadCommit(cwd);
      await writeFile(join(cwd, "file.txt"), "plan C\n", "utf8");
      await commitDirtyWorkspace(cwd, "plan C");
      const cCommits = await listCommitsBetween(cwd, beforeC, await getHeadCommit(cwd));

      const beforeWorktrees = await runGit(cwd, ["worktree", "list", "--porcelain"]);
      const analysis = await analyzeExecutionDependencies({
        workspaceCwd: cwd,
        baseCommit,
        previousExecutions: [
          { planId: "plan-a", commitShas: aCommits },
          { planId: "plan-b", commitShas: bCommits },
        ],
        currentCommitShas: cCommits,
      });
      const afterWorktrees = await runGit(cwd, ["worktree", "list", "--porcelain"]);

      assert.deepEqual(analysis.dependsOnPlanIds, ["plan-a", "plan-b"]);
      assert.equal(analysis.dependencyAnalysisStatus, "dependent");
      assert.equal(afterWorktrees.stdout, beforeWorktrees.stdout);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when a commit relies on unrecorded history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-workspace-failed-deps-"));
    try {
      await writeFile(join(cwd, "base.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(cwd, "base");

      await writeFile(join(cwd, "recorded.txt"), "recorded\n", "utf8");
      const beforeRecorded = await getHeadCommit(cwd);
      await commitDirtyWorkspace(cwd, "recorded plan");
      const recordedCommits = await listCommitsBetween(cwd, beforeRecorded, await getHeadCommit(cwd));

      await writeFile(join(cwd, "hidden.txt"), "hidden base\n", "utf8");
      await commitAll(cwd, "unrecorded intermediate");
      const beforeCurrent = await getHeadCommit(cwd);
      await writeFile(join(cwd, "hidden.txt"), "current plan\n", "utf8");
      await commitDirtyWorkspace(cwd, "current plan");
      const currentCommits = await listCommitsBetween(cwd, beforeCurrent, await getHeadCommit(cwd));

      const analysis = await analyzeExecutionDependencies({
        workspaceCwd: cwd,
        baseCommit,
        previousExecutions: [{ planId: "recorded", commitShas: recordedCommits }],
        currentCommitShas: currentCommits,
      });

      assert.equal(analysis.dependencyAnalysisStatus, "failed");
      assert.deepEqual(analysis.dependsOnPlanIds, ["recorded"]);
      assert.equal(await readFile(join(cwd, "hidden.txt"), "utf8"), "current plan\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detects dirty and diverged git project files only for affected paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-readiness-git-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "file.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(project, "base");
      const clone = await runGit(root, ["clone", project, workspace]);
      assert.equal(clone.exitCode, 0, clone.stderr);

      await writeFile(join(workspace, "file.txt"), "workspace\n", "utf8");
      await commitDirtyWorkspace(workspace, "workspace change");
      const changedFiles = await generateChangedFileList(workspace, baseCommit);

      await writeFile(join(project, "file.txt"), "dirty\n", "utf8");
      const dirty = await checkApplyProjectReadiness({
        projectRoot: project,
        workspaceCwd: workspace,
        baseCommit,
        changedFiles,
      });
      assert.equal(dirty.status, "dirty");
      assert.deepEqual(dirty.conflictingPaths, ["file.txt"]);

      await writeFile(join(project, "file.txt"), "base\n", "utf8");
      await writeFile(join(project, "other.txt"), "other\n", "utf8");
      await commitDirtyWorkspace(project, "unrelated");
      const unrelated = await checkApplyProjectReadiness({
        projectRoot: project,
        workspaceCwd: workspace,
        baseCommit,
        changedFiles,
      });
      assert.equal(unrelated.status, "clean");

      await writeFile(join(project, "file.txt"), "project\n", "utf8");
      await commitDirtyWorkspace(project, "project change");
      const diverged = await checkApplyProjectReadiness({
        projectRoot: project,
        workspaceCwd: workspace,
        baseCommit,
        changedFiles,
      });
      assert.equal(diverged.status, "diverged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects changed files in non-git projects using only affected paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-readiness-nongit-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    try {
      await mkdir(project, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(project, "file.txt"), "base\n", "utf8");
      await writeFile(join(project, "other.txt"), "changed\n", "utf8");
      await writeFile(join(workspace, "file.txt"), "base\n", "utf8");
      await writeFile(join(workspace, "other.txt"), "base\n", "utf8");
      const baseCommit = await initializeTemporaryGitRepository(workspace, "base");

      await writeFile(join(workspace, "file.txt"), "workspace\n", "utf8");
      await commitDirtyWorkspace(workspace, "workspace change");
      const changedFiles = await generateChangedFileList(workspace, baseCommit);

      const clean = await checkApplyProjectReadiness({
        projectRoot: project,
        workspaceCwd: workspace,
        baseCommit,
        changedFiles,
      });
      assert.equal(clean.status, "clean");

      await writeFile(join(project, "file.txt"), "project\n", "utf8");
      const changed = await checkApplyProjectReadiness({
        projectRoot: project,
        workspaceCwd: workspace,
        baseCommit,
        changedFiles,
      });
      assert.equal(changed.status, "changed");
      assert.deepEqual(changed.conflictingPaths, ["file.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
