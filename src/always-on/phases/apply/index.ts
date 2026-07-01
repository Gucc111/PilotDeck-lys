export { ApplyPhase } from "./ApplyPhase.js";
export { buildApplyPrompt, type BuildApplyPromptInput } from "./prompts.js";
export { buildApplyPromptZh } from "./prompts.zh.js";
export {
  applyCumulativeDiffToProject,
  applyWorktreeToProject,
  disposeWorkspace,
  generateWorkspaceDiff,
  type ProgrammaticApplyResult,
  type WorkspaceDiff,
} from "./workspaceLifecycle.js";
export type {
  ApplyPhaseDeps,
  ApplyPhaseInput,
  ApplyPhaseOutput,
} from "./types.js";
