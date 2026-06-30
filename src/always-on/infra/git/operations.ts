import { runGit, expectGitOk } from "./runner.js";
import type { ChangedFileEntry, CumulativeDiff } from "./types.js";

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
