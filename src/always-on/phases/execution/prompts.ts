import type { DiscoveryPlanRecord } from "../../infra/storage/types.js";
import { buildExecutionPromptZh } from "./prompts.zh.js";

export type BuildExecutionPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  language?: string;
};

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  if (input.language === "zh-CN") return buildExecutionPromptZh(input);
  return [
    "Execute the following plan.",
    "",
    "## Plan",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Execute the Execution Steps in order.",
    "2. Run the Verification list and record results.",
    "3. Before responding, run `git status --porcelain`.",
    "4. If there are local changes, run `git add -A` and commit them with a concise message.",
    "5. Respond with a summary of what was done and the verification outcomes.",
  ].join("\n");
}
