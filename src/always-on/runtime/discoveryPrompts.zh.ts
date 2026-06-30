import type { ChatDigest } from "../context/ChatDigestBuilder.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../tool/AlwaysOnWorkspaceTool.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../tool/AlwaysOnChatHistoryTool.js";
import type {
  BuildDiscoveryPromptInput,
  BuildWorkspacePromptInput,
  BuildExecutionPromptInput,
  BuildReportPromptInput,
  BuildApplyPromptInput,
  ExistingPlanSummary,
} from "./discoveryPrompts.js";

export function buildDiscoveryPromptZh(input: BuildDiscoveryPromptInput): string {
  const rootPath = input.workspace?.cwd ?? input.projectRoot;
  const headerLine = `你正在为项目执行自主 Always-On 发现任务: ${rootPath}`;

  const lines: string[] = [
    headerLine,
    "",
    "目标: 最多提出一个有价值的任务。",
    "",
    "发现流程:",
    "1. 首先理解项目的性质、领域和用户的工作目标 (浏览目录结构和关键文件)。",
    "2. 结合聊天记录和项目上下文, 预测用户的潜在需求, 发掘项目中值得推进的任务。",
    "",
    "当存在多个潜在任务时, 优先选择能实质性推进用户核心工作目标的任务,",
    "而非表面性的修补、格式美化或细节订正。",
    "站在用户的角度思考: 如果有一个主动帮手, 用户最希望它推进什么方向的工作?",
    "",
    "仅当项目为空或确实没有任何可改进之处时, 才可以不提出计划。",
  ];

  lines.push("", ...formatChatDigestSectionZh(input.chatDigest));
  lines.push("", ...formatExistingPlansSectionZh(input.existingPlans));
  lines.push("", ...formatPreferencesSectionZh(input.preferences));

  lines.push(
    "",
    `如果你发现了一个任务, 请调用 \`${ALWAYS_ON_PLAN_TOOL_NAME}\` 恰好一次, 提交格式严格的 markdown 计划。`,
    "计划结构要求 (自上而下):",
    "  - 一级标题: # <计划标题>",
    "  - 元数据引用块, 首行为 `Always-On Discovery Plan`, 后接键值行:",
    `    > id: plan_${input.runId}`,
    `    > sourceRunId: ${input.runId}`,
    `    > createdAt: ${input.createdAt}`,
    `    > projectRoot: ${input.projectRoot}`,
    "    > dedupeKey: <稳定标识符>",
    "  - 章节按以下顺序排列: ## Summary, ## Rationale, ## Context Signals, ## Proposed Change, ## Execution Steps, ## Verification。",
    "  - Summary 不超过 200 字符, 单段落。",
    "  - Context Signals: 至少一个 `-` 列表项。",
    "  - Execution Steps: 仅使用有序列表 (1., 2., …), 不使用无序列表。",
    "  - Verification: 至少一个 `-` 列表项, 每项必须可机器校验。",
    "",
    "硬性约束:",
    `  - 调用 \`${ALWAYS_ON_PLAN_TOOL_NAME}\` 超过一次将返回 plan_quota_exhausted。`,
    "  - 缺少必要章节、章节顺序错误、或包含模糊 'TODO' 措辞的计划将被拒绝。",
    "  - 不要包含 Risks 或 Rollback 章节。",
  );

  return lines.join("\n");
}

function formatChatDigestSectionZh(digest?: ChatDigest): string[] {
  if (!digest || digest.sessions.length === 0) {
    return [
      "未找到近期用户对话。请深入理解项目内容与目标, 优先发掘能实质性推进项目核心方向的任务, 而非仅修补细节。",
    ];
  }

  const lines: string[] = [
    "## 近期用户对话",
    "",
    "以下是近期用户-智能体对话的结构化摘要。",
    "其中可能揭示用户的深层目标、工作重心与关注方向, 而不仅仅是短期待办。",
    `如需查看某个会话的完整对话, 请使用 sessionId 调用 \`${ALWAYS_ON_CHAT_HISTORY_TOOL_NAME}\`。`,
    "",
  ];

  for (const session of digest.sessions) {
    const ts = session.lastModified.replace(/\.\d{3}Z$/, "Z");
    lines.push(`- [${ts}] "${session.title}" (sessionId: ${session.alias})`);
    for (const prompt of session.userPrompts) {
      const oneLiner = prompt.replace(/\n/g, " ").trim();
      lines.push(`  > ${oneLiner}`);
    }
    lines.push("");
  }

  return lines;
}

function formatPreferencesSectionZh(preferences?: string): string[] {
  if (!preferences?.trim()) return [];
  return [
    "## Always-On 用户偏好",
    "",
    "以下偏好来自历史计划的处置结果。",
    "避免提出与用户拒绝倾向一致的任务, 但不要将用户曾接受的任务类型视为唯一方向——",
    "保持自由探索, 主动发现用户可能尚未意识到的需求。",
    "",
    preferences.trim(),
  ];
}

function formatExistingPlansSectionZh(plans?: ExistingPlanSummary[]): string[] {
  if (!plans || plans.length === 0) return [];

  const active = plans.filter((plan) => (
    plan.status === "ready" ||
    plan.status === "executing" ||
    plan.status === "completed" ||
    plan.status === "completed_no_report"
  ));
  const applied = plans.filter((plan) => plan.status === "applied");
  const dismissed = plans.filter((plan) => plan.status === "archived" || plan.status === "failed");
  const lines: string[] = [];

  if (active.length > 0) {
    lines.push("## 待处理的累积计划 (已完成但尚未被应用或归档, 请勿重复这些主题)", "");
    for (const plan of active) {
      lines.push(`- [${plan.status}] "${plan.title}"`);
      if (plan.summary) lines.push(`  摘要: ${plan.summary}`);
    }
  }

  if (applied.length > 0) {
    lines.push("", "## 用户已采纳并应用到原项目的计划 (请勿重复这些主题)", "");
    for (const plan of applied) {
      lines.push(`- "${plan.title}"`);
      if (plan.summary) lines.push(`  摘要: ${plan.summary}`);
    }
  }

  if (dismissed.length > 0) {
    lines.push(
      "",
      "## 用户已抛弃的计划",
      "",
      "以下计划曾被用户抛弃或执行失败。不要提出完全相同的方案,",
      "但如果该方向仍有价值, 你可以用不同的角度或更优的方式重新提出。",
      "",
    );
    for (const plan of dismissed) {
      lines.push(`- [${plan.status}] "${plan.title}"`);
      if (plan.summary) lines.push(`  摘要: ${plan.summary}`);
    }
  }

  return lines;
}

export function buildWorkspacePromptZh(input: BuildWorkspacePromptInput): string {
  return [
    "你正在为 Always-On 计划执行准备一个隔离工作区。",
    "",
    `项目根目录: ${input.projectRoot}`,
    `计划: "${input.planTitle}"`,
    "",
    "可用的工作区策略:",
    "  - `git-worktree`: 在新分支上创建 git worktree。速度快、空间占用少 (使用硬链接)。",
    "    要求项目是 git 仓库且至少有一次提交。若工作区存在未提交更改，Always-On",
    "    会先提交当前全部改动作为 checkpoint，再创建 worktree。",
    "  - `snapshot-copy`: 复制项目目录 (在 APFS/btrfs 上使用 CoW)。适用于任何目录,",
    "    但占用更多磁盘空间。默认忽略 .git、node_modules、dist。",
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    "",
    "## 执行步骤",
    "1. 检查项目根目录状态 (如 git 仓库可执行 `git status --porcelain`, 否则执行 `ls`)。",
    `2. 调用 \`${ALWAYS_ON_WORKSPACE_TOOL_NAME}\`, 传入选定的策略, 或传入 \`auto\` 让运行时自动选择。`,
  ].join("\n");
}

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

export function buildReportPromptZh(input: BuildReportPromptInput): string {
  return [
    "你正在为已完成的 Always-On 计划执行撰写工作报告。",
    `工作区策略: ${input.workspaceStrategy}`,
    `工作区路径: ${input.workspaceCwd}`,
    "",
    "权限: 本轮运行在 `bypassPermissions` 模式下——所有工具调用均自动允许。",
    "",
    "## 已执行的计划",
    input.planMarkdown.trim(),
    "",
    "## 执行步骤",
    ...(input.executionCommitShas?.length
      ? [
          `1. 使用 \`git show --stat ${input.executionCommitShas.join(" ")}\` 查看 execution commits, 并检查相关文件。`,
        ]
      : [
          "1. 查看工作区中的变更 (如 `git diff --stat`、`ls`、阅读相关文件)。",
        ]),
    "2. 总结执行情况: 执行了哪些步骤、修改了哪些文件、命令输出、验证结果。",
    `3. 调用 \`${ALWAYS_ON_REPORT_TOOL_NAME}\` 恰好一次, 提交完整的工作报告 markdown。`,
    "",
    "每个章节必须使用 `##`（h2）标题——例如 `## Plan Reference`、`## Steps Performed` 等。",
    "报告章节按以下顺序排列: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes。",
    "缺失的章节将由运行时自动补全。",
  ].join("\n");
}

export function buildApplyPromptZh(input: BuildApplyPromptInput): string {
  const { workspaceCwd, baseCommit, projectRoot, changedFiles } = input;

  const lines: string[] = [
    "将隔离工作区中的一组文件变更合并到项目目录。",
    "",
    `工作目录（当前 cwd）: ${projectRoot}`,
    `隔离工作区: ${workspaceCwd}`,
    `Base commit: ${baseCommit}`,
  ];

  if (changedFiles.length === 0) {
    lines.push("", "未检测到文件变更，无需操作。");
    return lines.join("\n");
  }

  lines.push("", "## 合并方式", "");
  lines.push(...formatChangedFileListZh(changedFiles, input.isProjectGit));

  if (input.isProjectGit) {
    lines.push(
      "执行以下命令将变更应用到项目目录：",
      "",
      `  git -C ${workspaceCwd} diff ${baseCommit} HEAD --binary --find-renames | git apply`,
      "",
      "如果命令失败，根据上方文件清单，逐文件查看 diff 并手动编辑：",
      `  git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
      "不要使用 git merge / git cherry-pick / git am 等会产生 commit 的命令。",
    );
  } else {
    lines.push(
      "根据文件清单完成合并：",
      `- 新增/修改的文件：cp ${workspaceCwd}/<path> ./<path>（必要时先 mkdir -p 父目录）`,
      "- 删除的文件：rm ./<path>",
      "- 重命名的文件：cp 到新路径并 rm 旧路径",
      "- 可将多条命令合并到一个 shell 调用中批量执行",
      `- 如需查看某文件的具体改动：git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
      "",
      "不要使用任何 git 命令操作项目目录（它不是 git 仓库）。",
    );
  }

  return lines.join("\n");
}

function formatChangedFileListZh(
  files: Array<{ status: string; path: string; oldPath?: string }>,
  isGit: boolean,
): string[] {
  const label = isGit
    ? "相对于 base commit 的变更文件："
    : "相对于初始状态的变更文件：";
  const lines = [label];
  for (const f of files) {
    if (f.status === "R") {
      lines.push(`  - [R] ${f.oldPath} → ${f.path}`);
    } else {
      lines.push(`  - [${f.status}] ${f.path}`);
    }
  }
  lines.push("");
  return lines;
}
