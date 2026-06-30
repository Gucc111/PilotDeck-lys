import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./runner.js";
import {
  ALWAYS_ON_GIT_IDENTITY,
  generatePatchForCommits,
} from "./operations.js";
import type {
  ExecutionDependencyAnalysis,
  ExecutionForDependencyAnalysis,
  GitCommandResult,
} from "./types.js";

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
