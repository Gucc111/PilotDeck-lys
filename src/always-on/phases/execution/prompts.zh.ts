import type { BuildExecutionPromptInput } from "./prompts.js";

export function buildExecutionPromptZh(input: BuildExecutionPromptInput): string {
  return [
    "执行以下计划。",
    "",
    "## 计划",
    input.planMarkdown.trim(),
    "",
    "## 执行步骤",
    "1. 按顺序执行 Execution Steps 中的各项步骤。",
    "2. 运行 Verification 列表中的检查项并记录结果。",
    "3. 回复前执行 `git status --porcelain`。",
    "4. 如果存在本地改动, 执行 `git add -A` 并使用简短消息提交这些改动。",
    "5. 回复执行总结及验证结果。",
  ].join("\n");
}
