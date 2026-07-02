import type { ChatDigest } from "./context/index.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../../tool/AlwaysOnChatHistoryTool.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../../tool/AlwaysOnDiscoveryPlanTool.js";
import type { BuildDiscoveryPromptInput, ExistingPlanSummary } from "./prompts.js";

export function buildDiscoveryPromptZh(input: BuildDiscoveryPromptInput): string {
  const rootPath = input.workspace?.cwd ?? input.projectRoot;
  const lines: string[] = [
    `你正在为项目执行自主发现任务: ${rootPath}`,
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
    "## 用户偏好",
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
      lines.push(`- "${plan.title}"`);
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
      lines.push(`- "${plan.title}"`);
      if (plan.summary) lines.push(`  摘要: ${plan.summary}`);
    }
  }

  return lines;
}
