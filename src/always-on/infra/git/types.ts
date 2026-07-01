import type { WorkCycleDependencyAnalysisStatus } from "../storage/types.js";

export type ProcessCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitCommandResult = ProcessCommandResult;

export type RunProcessOptions = {
  stdin?: string;
};

export type RunGitOptions = RunProcessOptions & {
  gitBin?: string;
};

export type ExecutionDependencyAnalysis = {
  dependsOnPlanIds: string[];
  dependencyReasons: string[];
  dependencyAnalysisStatus: WorkCycleDependencyAnalysisStatus;
};

export type ExecutionForDependencyAnalysis = {
  planId: string;
  commitShas: string[];
};

export type ChangedFileEntry = {
  status: "A" | "M" | "D" | "R" | string;
  path: string;
  oldPath?: string;
};

export type CumulativeDiff = {
  diff: string;
  fileCount: number;
  truncated: boolean;
};

export type ApplyProjectReadinessStatus =
  | "clean"
  | "dirty"
  | "diverged"
  | "changed"
  | "unknown";

export type ApplyProjectReadiness = {
  isProjectGit: boolean;
  status: ApplyProjectReadinessStatus;
  changedFiles: ChangedFileEntry[];
  affectedPaths: string[];
  conflictingPaths: string[];
  message: string;
};
