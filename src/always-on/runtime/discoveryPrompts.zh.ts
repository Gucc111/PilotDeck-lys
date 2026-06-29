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
  const { plan, projectName, projectRoot, diff, branchName } = input;

  const lines: string[] = [
    `Always-On 应用变更到项目 "${projectName}"。`,
    "",
    "你的任务是将隔离工作区中的变更合并到项目根目录。",
    "",
    "不要进入计划模式。",
    "不要创建新计划——直接应用现有变更。",
    "",
    `计划: "${plan.title}" (${plan.id})`,
    `项目根目录: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    lines.push(`隔离工作区: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  if (branchName) {
    lines.push(`工作区分支: ${branchName}`);
  }

  if (input.commitScoped) {
    lines.push(
      "",
      "选中的 plan id:",
      ...(input.selectedPlanIds?.length ? input.selectedPlanIds.map((id) => `  - ${id}`) : ["  - 无"]),
      "",
      "选中的 execution commits（按应用顺序）:",
      ...(input.selectedCommitShas?.length ? input.selectedCommitShas.map((sha) => `  - ${sha}`) : ["  - 无改动 execution"]),
    );
  }

  lines.push("", "## 合并方式", "");

  if (input.isProjectGit !== undefined) {
    if (input.isProjectGit) {
      lines.push(
        "以下是隔离工作区相对于 baseCommit 的累积 diff。",
        "这个 diff 的上下文行基于 baseCommit，与你的工作区当前状态一致。",
        "",
        "推荐方式：",
        "1. 将以下 diff 保存为临时文件",
        "2. 在项目根目录执行 `git apply <patch-file>`",
        "3. 不要 commit——只修改工作树，由用户自行决定是否 commit",
        "",
        "注意：",
        "- 使用 `git apply`（不带 --3way），它只修改工作树文件，不产生 commit",
        "- 如果 apply 失败，使用 Edit/Write 工具按照 diff 手动编辑对应文件",
        "- 不要使用 git merge / git cherry-pick / git am 等会产生 commit 的命令",
        "",
      );
    } else {
      const wsCwd = plan.workspace?.cwd ?? "workspace";
      lines.push(
        "以下是隔离工作区相对于初始状态的变更文件清单和 diff。",
        "",
        "推荐方式：",
        "1. 对于新增/修改的文件，从隔离工作区复制到项目根目录：",
        `   mkdir -p <父目录> && cp ${wsCwd}/<path> ${projectRoot}/<path>`,
        "2. 对于重命名的文件：复制到新路径并删除旧路径",
        "3. 对于删除的文件：rm <projectRoot>/<path>",
        "4. 可以将多条复制命令合并到一个 shell 调用中批量执行",
        "",
        "如果需要检查或微调某个文件的内容后再写入，可使用 Read 工具查看隔离工作区中的文件，",
        "再用 Write/Edit 工具生成调整后的版本。",
        "",
        "不要使用任何 git 命令操作项目根目录（它不是 git 仓库）。",
        "",
      );

      if (input.changedFiles?.length) {
        lines.push("变更文件清单：");
        for (const f of input.changedFiles) {
          if (f.status === "R") {
            lines.push(`  - [重命名] ${f.oldPath} → ${f.path}`);
          } else if (f.status === "A") {
            lines.push(`  - [新增] ${f.path}`);
          } else if (f.status === "D") {
            lines.push(`  - [删除] ${f.path}`);
          } else {
            lines.push(`  - [修改] ${f.path}`);
          }
        }
        lines.push("");
      }
    }
  } else if (input.commitScoped) {
    lines.push(
      "只应用下方提供的选中 execution 补丁。",
      "不要合并整个隔离工作区分支, 也不要检查或应用属于未选 plan 的改动。",
      "",
      "根据实际情况选择最佳的合并策略。你可以完全使用 git 和 shell 工具。",
      "以下方补丁为唯一改动来源。可使用 git 应用补丁, 或通过精确文件编辑复现补丁。",
      "",
    );
  } else {
    lines.push(
      "根据实际情况选择最佳的合并策略。你可以完全使用 git 和 shell 工具。",
      "常见方式 (根据情况选择):",
      "  - `git merge` / `git merge --no-ff` 如果工作区在命名分支上",
      "  - `git cherry-pick` 针对单个提交",
      "  - `git diff` + `git apply` 基于补丁的应用",
      "  - 使用 Edit/Write 工具直接编辑文件, 适用于精确的小范围变更",
      "",
    );
  }

  if (input.isProjectGit === undefined) {
    lines.push(
      "如果遇到冲突, 请智能解决——不要盲目覆盖。",
      "如果无法解决冲突, 保留标准冲突标记 (<<<< / ==== / >>>>)。",
      "",
    );
  }

  if (!diff.diff.trim()) {
    lines.push("工作区未检测到差异。无需应用任何变更。");
    return lines.join("\n");
  }

  if (diff.truncated) {
    lines.push(
      `差异较大 (${diff.fileCount} 个文件), 已截断。`,
      "请从工作区目录读取相关文件进行对比和应用。",
      "",
      "截断后的差异 (前部内容):",
      "",
      diff.diff,
    );
  } else {
    lines.push(
      `变更内容 (${diff.fileCount} 个文件):`,
      "",
      diff.diff,
    );
  }

  return lines.join("\n");
}
