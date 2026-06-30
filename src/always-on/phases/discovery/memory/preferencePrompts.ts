import type { PreferenceEvent } from "../../../infra/storage/types.js";

const EXTRACTION_SYSTEM_PROMPT = `You are an Always-On preference analysis assistant. Based on how the user handled automatic task suggestions, analyze and update the user's preference summary.

Output format:
- Organize into two blocks: "## More likely to be accepted" and "## More likely to be rejected"
- Under each block, use sub-headings (### dimension name) to represent a preference dimension
- Derive dimensions from the event data instead of using a predefined taxonomy
- Describe each tendency tactfully and include 1–3 examples quoting original plan titles

Update rules:
- Add new evidence to an existing dimension when it fits
- Create a dimension when no existing dimension fits
- Record exceptions when new evidence contradicts an existing tendency
- Preserve unaffected dimensions verbatim

Output the COMPLETE updated preferences.md content, including all existing dimensions.
If no new preferences are discovered, output exactly: NONE`;

const EXTRACTION_SYSTEM_PROMPT_ZH = `你是一个 Always-On 偏好分析助手。根据用户对自动任务建议的处置结果，分析并更新用户的偏好摘要。

输出格式：
- 整体分为两大块："## 更可能被用户接受" 和 "## 更可能被用户拒绝"
- 每大块下使用子标题（### 维度名）表示一个偏好维度
- 维度不预设，完全从事件数据中提炼
- 每个维度使用委婉语气描述倾向，并附 1～3 个引用原始 plan 标题的例子

更新规则：
- 新证据适合已有维度时，补充到该维度
- 无已有维度可容纳时，创建新维度
- 新证据与已有倾向冲突时，补充例外说明
- 未受影响的维度原样保留

输出完整的更新后 preferences.md 内容，包含所有已有维度。
如果没有发现新的偏好，请准确输出：NONE`;

const CONSOLIDATION_SYSTEM_PROMPT = `You are an Always-On preference analysis assistant. Consolidate a user's preference summary by merging semantically similar dimensions and removing dimensions with insufficient evidence.

Rules:
- Merge dimensions that describe the same type of task preference
- Remove dimensions supported only by one weak example with no clear pattern
- Preserve the two-block structure: "## More likely to be accepted" and "## More likely to be rejected"
- Use a tactful tone
- Output the COMPLETE updated preferences.md content`;

const CONSOLIDATION_SYSTEM_PROMPT_ZH = `你是一个 Always-On 偏好分析助手。请合并整理用户的偏好摘要，将语义相近的维度合并，并删除证据不足的维度。

规则：
- 合并描述同类任务偏好的维度
- 删除只有一个弱证据且没有明确模式的维度
- 保留两大块结构："## 更可能被用户接受" 和 "## 更可能被用户拒绝"
- 使用委婉语气
- 输出完整的更新后 preferences.md 内容`;

export function buildExtractionSystemPrompt(language?: string): string {
  return language === "zh-CN" ? EXTRACTION_SYSTEM_PROMPT_ZH : EXTRACTION_SYSTEM_PROMPT;
}

export function buildExtractionUserPrompt(
  existingPreferences: string,
  newEvents: PreferenceEvent[],
  language?: string,
): string {
  const isZh = language === "zh-CN";
  const preferencesBlock = existingPreferences.trim()
    ? existingPreferences.trim()
    : isZh ? "暂无已有偏好" : "No existing preferences";

  const eventLines: string[] = [];
  for (const event of newEvents) {
    const action = event.action === "apply"
      ? (isZh ? "应用操作" : "Apply action")
      : (isZh ? "归档操作" : "Archive action");
    eventLines.push(`- ${action} (${event.timestamp})`);
    for (const plan of event.plans) {
      const outcome = plan.outcome === "applied" ? "Applied" : "Archived";
      let line = `  - [${outcome}] "${plan.title}"`;
      if (plan.summary) line += ` — ${plan.summary}`;
      eventLines.push(line);
    }
  }

  return [
    isZh ? "已有偏好：" : "Existing preferences:",
    preferencesBlock,
    "",
    isZh ? "新的用户操作：" : "New user actions:",
    ...eventLines,
  ].join("\n");
}

export function buildConsolidationSystemPrompt(language?: string): string {
  return language === "zh-CN" ? CONSOLIDATION_SYSTEM_PROMPT_ZH : CONSOLIDATION_SYSTEM_PROMPT;
}

export function buildConsolidationUserPrompt(preferences: string, language?: string): string {
  return [
    language === "zh-CN"
      ? "请合并整理以下偏好摘要："
      : "Please consolidate the following preference summary:",
    "",
    preferences.trim(),
  ].join("\n");
}
