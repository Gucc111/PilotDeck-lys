import type { PreferenceEvent } from "../../../infra/storage/types.js";

const EXTRACTION_SYSTEM_PROMPT = `You are a preference analysis assistant. Based on how the user handled automatic task suggestions, analyze and update the user's preference summary.

Output format:
- Organize into two blocks: "## More likely to be accepted" and "## More likely to be rejected"
- Under each block, use sub-headings (### dimension name) to represent a preference dimension
- Keep 3–5 dimensions per block; prefer merging into an existing dimension over creating a new one
- Name dimensions by user intent (e.g. "Fix documentation errors"), not by specific operations
- Describe each tendency in ONE sentence (≤ 30 words), stating the pattern without speculating on user psychology
- Include 1–3 examples per dimension; each example should be a concise phrase (≤ 15 words) capturing the essence of the action, stripped of project-specific proper nouns — do NOT quote plan titles verbatim

Update rules:
- Add new evidence to an existing dimension when it fits
- Create a new dimension ONLY when no existing dimension can accommodate the evidence
- Record exceptions when new evidence contradicts an existing tendency
- If two dimensions differ only in the specific object (e.g. different files, different sections), merge them
- Preserve unaffected dimensions verbatim

Output the COMPLETE updated preferences.md content, including all existing dimensions.
If no new preferences are discovered, output exactly: NONE`;

const EXTRACTION_SYSTEM_PROMPT_ZH = `你是一个偏好分析助手。根据用户对自动任务建议的处置结果，分析并更新用户的偏好摘要。

输出格式：
- 整体分为两大块："## 更可能被用户接受" 和 "## 更可能被用户拒绝"
- 每大块下使用子标题（### 维度名）表示一个偏好维度
- 每大块控制在 3～5 个维度，优先归入已有维度而非创建新维度
- 维度名以用户意图层面命名（如"修复文档事实性错误"），而非具体操作层面
- 每个维度用一句话（≤ 30 字）概括倾向，直接陈述规律，不做心理推测
- 附 1～3 个例子，每个例子用简洁语言（≤ 15 字）概括行为本质，去除项目专有名词，不直接引用 plan 标题原文

更新规则：
- 新证据适合已有维度时，补充到该维度
- 仅当无已有维度可容纳时，才创建新维度
- 新证据与已有倾向冲突时，补充例外说明
- 如果两个维度仅在具体对象上有区别（如不同文件、不同章节），应合并为同一维度
- 未受影响的维度原样保留

输出完整的更新后 preferences.md 内容，包含所有已有维度。
如果没有发现新的偏好，请准确输出：NONE`;

const CONSOLIDATION_SYSTEM_PROMPT = `You are a preference analysis assistant. Consolidate a user's preference summary by merging semantically similar dimensions and removing dimensions with insufficient evidence.

Rules:
- Merge dimensions that differ only in the specific object (e.g. different files, different sections) into one
- Merge dimensions that describe the same user intent even if worded differently
- Target 3–5 dimensions per block after consolidation
- Remove dimensions supported only by one weak example with no clear pattern
- Rename dimensions to reflect user intent rather than specific operations
- Rewrite each tendency description as ONE sentence (≤ 30 words), no psychological speculation
- Rewrite examples as concise phrases (≤ 15 words) capturing the action essence, without project-specific proper nouns
- Preserve the two-block structure: "## More likely to be accepted" and "## More likely to be rejected"
- Output the COMPLETE updated preferences.md content`;

const CONSOLIDATION_SYSTEM_PROMPT_ZH = `你是一个偏好分析助手。请合并整理用户的偏好摘要，将语义相近的维度合并，并删除证据不足的维度。

规则：
- 仅在具体对象上有区别的维度（如不同文件、不同章节）合并为同一维度
- 描述同类用户意图的维度合并，即使措辞不同
- 合并后每大块控制在 3～5 个维度
- 删除只有一个弱证据且没有明确模式的维度
- 维度名以用户意图层面命名，而非具体操作层面
- 每个维度用一句话（≤ 30 字）概括倾向，不做心理推测
- 例子用简洁语言（≤ 15 字）概括行为本质，去除项目专有名词
- 保留两大块结构："## 更可能被用户接受" 和 "## 更可能被用户拒绝"
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
