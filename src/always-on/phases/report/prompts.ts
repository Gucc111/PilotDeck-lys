import type { DiscoveryPlanRecord } from "../../protocol/types.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../../tool/AlwaysOnReportTool.js";
import { buildReportPromptZh } from "./prompts.zh.js";

export type BuildReportPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  executionCommitShas?: string[];
  language?: string;
};

export function buildReportPrompt(input: BuildReportPromptInput): string {
  if (input.language === "zh-CN") return buildReportPromptZh(input);
  return [
    "You are writing a work report for a completed Always-On plan execution.",
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## Plan that was executed",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    ...(input.executionCommitShas?.length
      ? [
          `1. Review the execution commits with \`git show --stat ${input.executionCommitShas.join(" ")}\` and inspect relevant files.`,
        ]
      : [
          "1. Review the workspace to see what changed (e.g. `git diff --stat`, `ls`, read relevant files).",
        ]),
    "2. Summarize the execution: what steps were performed, which files were changed, command outputs, and verification results.",
    `3. Call \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the full work-report markdown.`,
    "",
    "Each section MUST use `##` (h2) headers — e.g. `## Plan Reference`, `## Steps Performed`, etc.",
    "Required sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}
