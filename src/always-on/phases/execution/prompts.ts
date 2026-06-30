import type { DiscoveryPlanRecord } from "../../protocol/types.js";
import { buildExecutionPromptZh } from "./prompts.zh.js";

export type BuildExecutionPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  language?: string;
};

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  if (input.language === "zh-CN") return buildExecutionPromptZh(input);
  return [
    `You are executing an Always-On discovery plan inside an isolated workspace.`,
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "Safety boundary is the workspace itself; do NOT cd outside it, do NOT touch the user's project root.",
    "",
    "## Plan",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Execute the Execution Steps in order.",
    "2. Run the Verification list and record results.",
    "3. Before responding, run `git status --porcelain` in the isolated workspace.",
    "4. If there are local changes, run `git add -A` and commit them with a concise message.",
    "5. Respond with a summary of what was done and the verification outcomes.",
  ].join("\n");
}
