import { ALWAYS_ON_REPORT_TOOL_NAME } from "../../tool/AlwaysOnReportTool.js";
import { buildReportPromptZh } from "./prompts.zh.js";

export type BuildReportPromptInput = {
  executionCommitShas?: string[];
  language?: string;
};

export function buildReportPrompt(input: BuildReportPromptInput): string {
  if (input.language === "zh-CN") return buildReportPromptZh(input);
  return [
    "Write a work report for the plan execution just completed. Focus on the work performed and the observed results.",
    "",
    "## What to do",
    ...(input.executionCommitShas?.length
      ? [
          `1. Review the execution commits with \`git show --stat ${input.executionCommitShas.join(" ")}\` and inspect relevant files.`,
        ]
      : [
          "1. Review the workspace to see what changed (e.g. `git diff --stat`, `ls`, read relevant files).",
        ]),
    "2. Summarize this session's execution: what steps were performed, which files were changed, command outputs, verification results, and follow-ups.",
    `3. Call \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the full work-report markdown.`,
    "",
    "Each section MUST use `##` (h2) headers — e.g. `## Plan Reference`, `## Steps Performed`, etc.",
    "Required sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}
