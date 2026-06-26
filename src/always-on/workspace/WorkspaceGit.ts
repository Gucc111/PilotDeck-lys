import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExecutionDependencyAnalysis = {
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: "clean" | "dependent" | "failed";
};

export type ExecutionForDependencyAnalysis = {
  planId: string;
  commitShas: string[];
};

const ALWAYS_ON_GIT_IDENTITY = [
  "-c",
  "user.name=PilotDeck Always-On",
  "-c",
  "user.email=always-on@pilotdeck.local",
];

export async function runGit(
  cwd: string,
  args: string[],
  options: { gitBin?: string; stdin?: string } = {},
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolvePromise) => {
    const child = spawn(options.gitBin ?? "git", ["-C", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

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

export async function analyzeExecutionDependencies(input: {
  workspaceCwd: string;
  baseCommit: string;
  previousExecutions: ExecutionForDependencyAnalysis[];
  currentCommitShas: string[];
  gitBin?: string;
}): Promise<ExecutionDependencyAnalysis> {
  const gitBin = input.gitBin ?? "git";
  if (input.currentCommitShas.length === 0) {
    return { dependsOnPlanIds: [], dependencyReasons: [], dependencyAnalysisStatus: "clean" };
  }

  const currentPatch = await generatePatchForCommits(input.workspaceCwd, input.currentCommitShas, gitBin);
  if (await canApplyWithDependencies(input.workspaceCwd, input.baseCommit, [], currentPatch, gitBin)) {
    return { dependsOnPlanIds: [], dependencyReasons: [], dependencyAnalysisStatus: "clean" };
  }

  const candidates = input.previousExecutions.filter((execution) => execution.commitShas.length > 0);
  const candidatePatches = await Promise.all(
    candidates.map(async (execution) => ({
      planId: execution.planId,
      patch: await generatePatchForCommits(input.workspaceCwd, execution.commitShas, gitBin),
    })),
  );

  if (!(await canApplyWithDependencies(input.workspaceCwd, input.baseCommit, candidatePatches, currentPatch, gitBin))) {
    return {
      dependsOnPlanIds: candidates.map((execution) => execution.planId),
      dependencyReasons: ["Could not replay current execution even after applying all earlier execution commits."],
      dependencyAnalysisStatus: "failed",
    };
  }

  let required = [...candidatePatches];
  for (const candidate of candidatePatches) {
    const trial = required.filter((entry) => entry.planId !== candidate.planId);
    if (await canApplyWithDependencies(input.workspaceCwd, input.baseCommit, trial, currentPatch, gitBin)) {
      required = trial;
    }
  }

  return {
    dependsOnPlanIds: required.map((execution) => execution.planId),
    dependencyReasons: required.map((execution) => `Requires commits from plan ${execution.planId} to apply cleanly.`),
    dependencyAnalysisStatus: required.length > 0 ? "dependent" : "clean",
  };
}

async function applyPatch(
  cwd: string,
  patch: string,
  gitBin: string,
): Promise<GitCommandResult> {
  if (!patch.trim()) return { exitCode: 0, stdout: "", stderr: "" };
  return runGit(cwd, ["apply", "--3way", "--whitespace=nowarn"], { gitBin, stdin: patch });
}

async function canApplyWithDependencies(
  repoCwd: string,
  baseCommit: string,
  dependencyPatches: Array<{ planId: string; patch: string }>,
  currentPatch: string,
  gitBin: string,
): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-deps-"));
  let worktreeAdded = false;
  try {
    const add = await runGit(repoCwd, ["worktree", "add", "--detach", scratch, baseCommit], { gitBin });
    if (add.exitCode !== 0) return false;
    worktreeAdded = true;

    for (const dependency of dependencyPatches) {
      const applied = await applyPatch(scratch, dependency.patch, gitBin);
      if (applied.exitCode !== 0) return false;
      const addAll = await runGit(scratch, ["add", "-A"], { gitBin });
      if (addAll.exitCode !== 0) return false;
      const commit = await runGit(
        scratch,
        [...ALWAYS_ON_GIT_IDENTITY, "commit", "--allow-empty", "-m", `dependency ${dependency.planId}`],
        { gitBin },
      );
      if (commit.exitCode !== 0) return false;
    }

    const current = await applyPatch(scratch, currentPatch, gitBin);
    return current.exitCode === 0;
  } finally {
    if (worktreeAdded) {
      await runGit(repoCwd, ["worktree", "remove", "--force", scratch], { gitBin }).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function expectGitOk(result: GitCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
}
