import { rm } from "node:fs/promises";
import { runGit, runProcess } from "../../infra/git/index.js";

export type WorkspaceDiff = {
  diff: string;
  fileCount: number;
  truncated: boolean;
};

export type ProgrammaticApplyResult = {
  applied: boolean;
  diff?: string;
  error?: string;
  command: string;
  stdout?: string;
  stderr?: string;
};

const MAX_INLINE_DIFF_CHARS = 80_000;

export async function generateWorkspaceDiff(
  strategy: string,
  workspaceCwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<WorkspaceDiff> {
  if (strategy === "git-worktree") {
    return generateGitWorktreeDiff(workspaceCwd, gitBin);
  }
  return generateSnapshotCopyDiff(workspaceCwd, projectRoot);
}

async function generateGitWorktreeDiff(
  workspaceCwd: string,
  gitBin: string,
): Promise<WorkspaceDiff> {
  const addAll = await runGit(workspaceCwd, ["add", "-A"], { gitBin });
  if (addAll.exitCode !== 0) {
    return { diff: "", fileCount: 0, truncated: false };
  }

  const statResult = await runGit(workspaceCwd, ["diff", "--cached", "HEAD", "--stat"], { gitBin });
  const fileCount = statResult.exitCode === 0
    ? (statResult.stdout.match(/\n/g) || []).length - 1
    : 0;

  const diffResult = await runGit(workspaceCwd, ["diff", "--cached", "HEAD"], { gitBin });
  if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
    return { diff: "", fileCount: Math.max(fileCount, 0), truncated: false };
  }

  const fullDiff = diffResult.stdout;
  if (fullDiff.length > MAX_INLINE_DIFF_CHARS) {
    return {
      diff: fullDiff.slice(0, MAX_INLINE_DIFF_CHARS),
      fileCount: Math.max(fileCount, 0),
      truncated: true,
    };
  }
  return { diff: fullDiff, fileCount: Math.max(fileCount, 0), truncated: false };
}

async function generateSnapshotCopyDiff(
  workspaceCwd: string,
  projectRoot: string,
): Promise<WorkspaceDiff> {
  const result = await runProcess("diff", [
    "-ruN",
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=.pilotdeck",
    "--exclude=.pilotdeck-always-on",
    projectRoot,
    workspaceCwd,
  ]);

  if (result.exitCode > 1) {
    return { diff: "", fileCount: 0, truncated: false };
  }

  const fullDiff = result.stdout;
  const fileCount = (fullDiff.match(/^diff /gm) || []).length;

  if (fullDiff.length > MAX_INLINE_DIFF_CHARS) {
    return {
      diff: fullDiff.slice(0, MAX_INLINE_DIFF_CHARS),
      fileCount,
      truncated: true,
    };
  }
  return { diff: fullDiff, fileCount, truncated: false };
}

export async function applyWorktreeToProject(
  worktreeCwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<{ applied: boolean; diff?: string; error?: string }> {
  const addAll = await runGit(worktreeCwd, ["add", "-A"], { gitBin });
  if (addAll.exitCode !== 0) {
    return { applied: false, error: `git add -A failed: ${addAll.stderr}` };
  }

  const diffResult = await runGit(worktreeCwd, [
    "diff", "--cached", "HEAD",
    "--binary",
  ], { gitBin });
  if (diffResult.exitCode !== 0) {
    return { applied: false, error: `git diff failed: ${diffResult.stderr}` };
  }

  const patch = diffResult.stdout;
  if (!patch.trim()) {
    return { applied: true, diff: "" };
  }

  const applyResult = await runGit(projectRoot, ["apply", "--3way"], { gitBin, stdin: patch });

  if (applyResult.exitCode !== 0) {
    return {
      applied: false,
      diff: patch,
      error: `git apply failed: ${applyResult.stderr || applyResult.stdout}`,
    };
  }

  return { applied: true, diff: patch };
}

export async function applyCumulativeDiffToProject(
  worktreeCwd: string,
  baseCommit: string,
  projectRoot: string,
  gitBin = "git",
): Promise<ProgrammaticApplyResult> {
  const command = `git -C ${worktreeCwd} diff ${baseCommit} HEAD --binary --find-renames | git -C ${projectRoot} apply`;
  const diffResult = await runGit(worktreeCwd, [
    "diff",
    baseCommit,
    "HEAD",
    "--binary",
    "--find-renames",
  ], { gitBin });
  if (diffResult.exitCode !== 0) {
    return {
      applied: false,
      command,
      stdout: diffResult.stdout,
      stderr: diffResult.stderr,
      error: `git diff failed: ${diffResult.stderr || diffResult.stdout}`,
    };
  }

  const patch = diffResult.stdout;
  if (!patch.trim()) {
    return { applied: true, diff: "", command };
  }

  const applyResult = await runGit(projectRoot, ["apply"], { gitBin, stdin: patch });
  if (applyResult.exitCode !== 0) {
    return {
      applied: false,
      diff: patch,
      command,
      stdout: applyResult.stdout,
      stderr: applyResult.stderr,
      error: `git apply failed: ${applyResult.stderr || applyResult.stdout}`,
    };
  }

  return { applied: true, diff: patch, command, stdout: applyResult.stdout, stderr: applyResult.stderr };
}

export async function disposeWorkspace(
  strategy: string,
  cwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<void> {
  if (strategy === "git-worktree") {
    const remove = await runGit(projectRoot, ["worktree", "remove", "--force", cwd], { gitBin }).catch(() => undefined);

    if (!remove || remove.exitCode !== 0) {
      await rm(cwd, { recursive: true, force: true });
      await runGit(projectRoot, ["worktree", "prune"], { gitBin }).catch(() => undefined);
    }
    return;
  }

  await rm(cwd, { recursive: true, force: true });
}
