export { ApplyPhase } from "./ApplyPhase.js";
export { buildApplyPrompt, type BuildApplyPromptInput } from "./prompts.js";
export { buildApplyPromptZh } from "./prompts.zh.js";
export {
  applyWorktreeToProject,
  disposeWorkspace,
  generateWorkspaceDiff,
  type WorkspaceDiff,
} from "./workspaceLifecycle.js";
export type {
  ApplyPhaseDeps,
  ApplyPhaseInput,
  ApplyPhaseOutput,
} from "./types.js";
