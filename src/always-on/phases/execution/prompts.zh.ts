import type { BuildExecutionPromptInput } from "./prompts.js";

export function buildExecutionPromptZh(input: BuildExecutionPromptInput): string {
  return [
    "你正在隔离工作区内执行一个 Always-On 发现计划。",
    `工作区策略: ${input.workspaceStrategy}`,
    `工作区路径: ${input.workspaceCwd}`,
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    "安全边界为工作区本身; 请勿 cd 到工作区外部, 请勿修改用户的项目根目录。",
    "",
    "## 计划",
    input.planMarkdown.trim(),
    "",
    "## 执行步骤",
    "1. 按顺序执行 Execution Steps 中的各项步骤。",
    "2. 运行 Verification 列表中的检查项并记录结果。",
    "3. 回复前在隔离工作区执行 `git status --porcelain`。",
    "4. 如果存在本地改动, 执行 `git add -A` 并使用简短消息提交这些改动。",
    "5. 回复执行总结及验证结果。",
  ].join("\n");
}
