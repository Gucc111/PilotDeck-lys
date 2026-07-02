import { ALWAYS_ON_REPORT_TOOL_NAME } from "../../tool/AlwaysOnReportTool.js";
import type { BuildReportPromptInput } from "./prompts.js";

export function buildReportPromptZh(input: BuildReportPromptInput): string {
  return [
    "请为刚完成的计划执行撰写工作报告, 聚焦实际完成的工作和可观察结果。",
    "",
    "## 执行步骤",
    ...(input.executionCommitShas?.length
      ? [
          `1. 使用 \`git show --stat ${input.executionCommitShas.join(" ")}\` 查看 execution commits, 并检查相关文件。`,
        ]
      : [
          "1. 查看工作区中的变更 (如 `git diff --stat`、`ls`、阅读相关文件)。",
        ]),
    "2. 总结本次会话的执行情况: 执行了哪些步骤、修改了哪些文件、命令输出、验证结果和后续事项。",
    `3. 调用 \`${ALWAYS_ON_REPORT_TOOL_NAME}\` 恰好一次, 提交完整的工作报告 markdown。`,
    "",
    "每个章节必须使用 `##`（h2）标题——例如 `## Plan Reference`、`## Steps Performed` 等。",
    "报告章节按以下顺序排列: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes。",
    "缺失的章节将由运行时自动补全。",
  ].join("\n");
}
