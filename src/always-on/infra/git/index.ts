export type {
  ChangedFileEntry,
  CumulativeDiff,
  ExecutionDependencyAnalysis,
  ExecutionForDependencyAnalysis,
  GitCommandResult,
  ProcessCommandResult,
  RunGitOptions,
  RunProcessOptions,
} from "./types.js";
export { GitCommandError } from "./errors.js";
export {
  expectGitOk,
  isGitAvailable,
  runGit,
  runProcess,
} from "./runner.js";
export {
  ALWAYS_ON_GIT_IDENTITY,
  commitDirtyWorkspace,
  generateChangedFileList,
  generateCumulativeDiff,
  generatePatchForCommits,
  getHeadCommit,
  getStatusPorcelain,
  initializeTemporaryGitRepository,
  isGitRepository,
  listCommitsBetween,
  revertCommits,
} from "./operations.js";
export { analyzeExecutionDependencies } from "./dependencyAnalysis.js";
