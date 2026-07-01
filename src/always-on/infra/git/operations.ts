import { access, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runGit, expectGitOk } from "./runner.js";
import type {
  ApplyProjectReadiness,
  ChangedFileEntry,
  CumulativeDiff,
} from "./types.js";

export const ALWAYS_ON_GIT_IDENTITY = [
  "-c",
  "user.name=PilotDeck Always-On",
  "-c",
  "user.email=always-on@pilotdeck.local",
];

const MAX_CUMULATIVE_DIFF_CHARS = 80_000;

export async function isGitRepository(cwd: string, gitBin = "git"): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { gitBin }).catch(() => undefined);
  return !!result && result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function getHeadCommit(cwd: string, gitBin = "git"): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "HEAD"], { gitBin });
  expectGitOk(result, "git rev-parse HEAD");
  return result.stdout.trim();
}

export async function getStatusPorcelain(cwd: string, gitBin = "git"): Promise<string> {
  const result = await runGit(cwd, ["status", "--porcelain"], { gitBin });
  expectGitOk(result, "git status --porcelain");
  return result.stdout.trim();
}

export async function initializeTemporaryGitRepository(
  cwd: string,
  message: string,
  gitBin = "git",
): Promise<string> {
  const init = await runGit(cwd, ["init"], { gitBin });
  expectGitOk(init, "git init");
  const add = await runGit(cwd, ["add", "-A"], { gitBin });
  expectGitOk(add, "git add -A");
  const commit = await runGit(
    cwd,
    [...ALWAYS_ON_GIT_IDENTITY, "commit", "--allow-empty", "-m", message],
    { gitBin },
  );
  expectGitOk(commit, "git commit snapshot base");
  return getHeadCommit(cwd, gitBin);
}

export async function commitDirtyWorkspace(
  cwd: string,
  message: string,
  gitBin = "git",
): Promise<{ committed: boolean; commitSha?: string }> {
  const status = await getStatusPorcelain(cwd, gitBin);
  if (!status) return { committed: false };

  const add = await runGit(cwd, ["add", "-A"], { gitBin });
  expectGitOk(add, "git add -A");
  const commit = await runGit(
    cwd,
    [...ALWAYS_ON_GIT_IDENTITY, "commit", "-m", message],
    { gitBin },
  );
  expectGitOk(commit, "git commit workspace changes");
  return { committed: true, commitSha: await getHeadCommit(cwd, gitBin) };
}

export async function listCommitsBetween(
  cwd: string,
  beforeHead: string,
  afterHead: string,
  gitBin = "git",
): Promise<string[]> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  const result = await runGit(cwd, ["rev-list", "--reverse", `${beforeHead}..${afterHead}`], { gitBin });
  expectGitOk(result, "git rev-list");
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function generatePatchForCommits(
  cwd: string,
  commitShas: string[],
  gitBin = "git",
): Promise<string> {
  const patches: string[] = [];
  for (const sha of commitShas) {
    const result = await runGit(cwd, ["show", "--format=", "--binary", "--find-renames", sha], { gitBin });
    expectGitOk(result, `git show ${sha}`);
    if (result.stdout.trim()) patches.push(result.stdout);
  }
  return patches.join("\n");
}

export async function generateCumulativeDiff(
  cwd: string,
  baseCommit: string,
  gitBin = "git",
): Promise<CumulativeDiff> {
  const result = await runGit(
    cwd,
    ["diff", baseCommit, "HEAD", "--binary", "--find-renames"],
    { gitBin },
  );
  expectGitOk(result, "git diff (cumulative)");
  const fullDiff = result.stdout;
  const fileCount = (fullDiff.match(/^diff --git /gm) ?? []).length;
  if (fullDiff.length > MAX_CUMULATIVE_DIFF_CHARS) {
    return {
      diff: fullDiff.slice(0, MAX_CUMULATIVE_DIFF_CHARS),
      fileCount,
      truncated: true,
    };
  }
  return { diff: fullDiff, fileCount, truncated: false };
}

export async function generateChangedFileList(
  cwd: string,
  baseCommit: string,
  gitBin = "git",
): Promise<ChangedFileEntry[]> {
  const result = await runGit(
    cwd,
    ["diff", "--name-status", baseCommit, "HEAD"],
    { gitBin },
  );
  expectGitOk(result, "git diff --name-status");
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const statusCode = parts[0][0];
      if (statusCode === "R") {
        return { status: "R", path: parts[2] ?? parts[1], oldPath: parts[1] };
      }
      return { status: statusCode, path: parts[1] ?? "" };
    })
    .filter((entry) => entry.path.length > 0);
}

export async function generateApplyChangedFileList(
  cwd: string,
  baseCommit: string,
  unselectedCommitShas: string[],
  gitBin = "git",
): Promise<ChangedFileEntry[]> {
  const commits = unselectedCommitShas.filter(Boolean);
  if (commits.length === 0) {
    return generateChangedFileList(cwd, baseCommit, gitBin);
  }

  const scratch = await mkdtemp(join(tmpdir(), "pilotdeck-apply-readiness-"));
  let worktreeAdded = false;
  try {
    const add = await runGit(cwd, ["worktree", "add", "--detach", scratch, "HEAD"], { gitBin });
    expectGitOk(add, "git worktree add apply readiness scratch");
    worktreeAdded = true;

    const reverted = await revertCommits(scratch, commits, gitBin);
    if (!reverted.reverted) {
      throw new Error(reverted.error ?? "Failed to revert unselected commits in readiness scratch worktree");
    }
    return generateChangedFileList(scratch, baseCommit, gitBin);
  } finally {
    if (worktreeAdded) {
      await runGit(cwd, ["worktree", "remove", "--force", scratch], { gitBin }).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function checkApplyProjectReadiness(input: {
  projectRoot: string;
  workspaceCwd: string;
  baseCommit: string;
  changedFiles: ChangedFileEntry[];
  gitBin?: string;
}): Promise<ApplyProjectReadiness> {
  const gitBin = input.gitBin ?? "git";
  const affectedPaths = collectAffectedPaths(input.changedFiles);
  const projectIsGit = await isGitRepository(input.projectRoot, gitBin);

  if (affectedPaths.length === 0) {
    return {
      isProjectGit: projectIsGit,
      status: "clean",
      changedFiles: input.changedFiles,
      affectedPaths,
      conflictingPaths: [],
      message: "No affected files to check.",
    };
  }

  if (projectIsGit) {
    return checkGitProjectReadiness({
      projectRoot: input.projectRoot,
      baseCommit: input.baseCommit,
      changedFiles: input.changedFiles,
      affectedPaths,
      gitBin,
    });
  }

  return checkNonGitProjectReadiness({
    projectRoot: input.projectRoot,
    workspaceCwd: input.workspaceCwd,
    baseCommit: input.baseCommit,
    changedFiles: input.changedFiles,
    affectedPaths,
    gitBin,
  });
}

export async function revertCommits(
  cwd: string,
  commitShas: string[],
  gitBin = "git",
): Promise<{ reverted: boolean; error?: string }> {
  const ordered = [...commitShas].reverse().filter(Boolean);
  if (ordered.length === 0) return { reverted: true };

  const status = await getStatusPorcelain(cwd, gitBin);
  if (status) {
    return { reverted: false, error: "Workspace has uncommitted changes." };
  }

  for (const sha of ordered) {
    const result = await runGit(
      cwd,
      [...ALWAYS_ON_GIT_IDENTITY, "revert", "--no-edit", sha],
      { gitBin },
    );
    if (result.exitCode !== 0) {
      await runGit(cwd, ["revert", "--abort"], { gitBin }).catch(() => undefined);
      return {
        reverted: false,
        error: `git revert ${sha} failed: ${result.stderr || result.stdout}`,
      };
    }
  }

  return { reverted: true };
}

function collectAffectedPaths(files: ChangedFileEntry[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const next = normalizeGitRelativePath(file.path);
    if (next) paths.add(next);
    const old = normalizeGitRelativePath(file.oldPath);
    if (old) paths.add(old);
  }
  return [...paths].sort();
}

function normalizeGitRelativePath(raw: string | undefined): string | undefined {
  if (!raw || raw.includes("\0") || raw.startsWith("/") || raw.startsWith("\\")) return undefined;
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return undefined;
  }
  return normalized;
}

async function checkGitProjectReadiness(input: {
  projectRoot: string;
  baseCommit: string;
  changedFiles: ChangedFileEntry[];
  affectedPaths: string[];
  gitBin: string;
}): Promise<ApplyProjectReadiness> {
  const status = await runGit(
    input.projectRoot,
    ["status", "--porcelain", "--", ...input.affectedPaths],
    { gitBin: input.gitBin },
  );
  if (status.exitCode !== 0) {
    return unknownReadiness(true, input.changedFiles, input.affectedPaths, `git status failed: ${status.stderr || status.stdout}`);
  }

  const dirtyPaths = parseStatusPaths(status.stdout, input.affectedPaths);
  if (dirtyPaths.length > 0) {
    return {
      isProjectGit: true,
      status: "dirty",
      changedFiles: input.changedFiles,
      affectedPaths: input.affectedPaths,
      conflictingPaths: dirtyPaths,
      message: "Project has uncommitted changes in files touched by the selected plans.",
    };
  }

  const diff = await runGit(
    input.projectRoot,
    ["diff", "--quiet", input.baseCommit, "HEAD", "--", ...input.affectedPaths],
    { gitBin: input.gitBin },
  );
  if (diff.exitCode === 0) {
    return {
      isProjectGit: true,
      status: "clean",
      changedFiles: input.changedFiles,
      affectedPaths: input.affectedPaths,
      conflictingPaths: [],
      message: "Project files touched by the selected plans still match the apply base.",
    };
  }
  if (diff.exitCode === 1) {
    return {
      isProjectGit: true,
      status: "diverged",
      changedFiles: input.changedFiles,
      affectedPaths: input.affectedPaths,
      conflictingPaths: input.affectedPaths,
      message: "Project files touched by the selected plans have changed since the apply base.",
    };
  }

  return unknownReadiness(true, input.changedFiles, input.affectedPaths, `git diff failed: ${diff.stderr || diff.stdout}`);
}

async function checkNonGitProjectReadiness(input: {
  projectRoot: string;
  workspaceCwd: string;
  baseCommit: string;
  changedFiles: ChangedFileEntry[];
  affectedPaths: string[];
  gitBin: string;
}): Promise<ApplyProjectReadiness> {
  const conflicts = new Set<string>();
  for (const file of input.changedFiles) {
    const path = normalizeGitRelativePath(file.path);
    const oldPath = normalizeGitRelativePath(file.oldPath);
    if (file.status === "A") {
      if (path && await pathExists(join(input.projectRoot, path))) conflicts.add(path);
      continue;
    }

    const basePath = file.status === "R" ? oldPath : path;
    if (basePath && !(await projectFileMatchesBase(input.workspaceCwd, input.projectRoot, input.baseCommit, basePath, input.gitBin))) {
      conflicts.add(basePath);
    }
    if (file.status === "R" && path && await pathExists(join(input.projectRoot, path))) {
      conflicts.add(path);
    }
  }

  if (conflicts.size > 0) {
    return {
      isProjectGit: false,
      status: "changed",
      changedFiles: input.changedFiles,
      affectedPaths: input.affectedPaths,
      conflictingPaths: [...conflicts].sort(),
      message: "Project files touched by the selected plans have changed since the initial snapshot.",
    };
  }

  return {
    isProjectGit: false,
    status: "clean",
    changedFiles: input.changedFiles,
    affectedPaths: input.affectedPaths,
    conflictingPaths: [],
    message: "Project files touched by the selected plans still match the initial snapshot.",
  };
}

async function projectFileMatchesBase(
  workspaceCwd: string,
  projectRoot: string,
  baseCommit: string,
  relativePath: string,
  gitBin: string,
): Promise<boolean> {
  const base = await runGit(workspaceCwd, ["show", `${baseCommit}:${relativePath}`], { gitBin });
  if (base.exitCode !== 0) return false;
  const projectPath = join(projectRoot, relativePath);
  try {
    const current = await readFile(projectPath, "utf8");
    return current === base.stdout;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseStatusPaths(status: string, affectedPaths: string[]): string[] {
  const affected = new Set(affectedPaths);
  const matches = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    const raw = line.slice(3).trim();
    if (!raw) continue;
    for (const part of raw.split(" -> ")) {
      const normalized = normalizeGitRelativePath(part.replace(/^"|"$/g, ""));
      if (normalized && affected.has(normalized)) matches.add(normalized);
    }
  }
  return [...matches].sort();
}

function unknownReadiness(
  isProjectGit: boolean,
  changedFiles: ChangedFileEntry[],
  affectedPaths: string[],
  message: string,
): ApplyProjectReadiness {
  return {
    isProjectGit,
    status: "unknown",
    changedFiles,
    affectedPaths,
    conflictingPaths: [],
    message,
  };
}
