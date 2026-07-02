import type { ChatDigest } from "./context/index.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../../tool/AlwaysOnChatHistoryTool.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../../tool/AlwaysOnDiscoveryPlanTool.js";
import { buildDiscoveryPromptZh } from "./prompts.zh.js";

export type ExistingPlanSummary = {
  id: string;
  title: string;
  summary?: string;
  status: string;
};

export type BuildDiscoveryPromptInput = {
  projectRoot: string;
  runId: string;
  createdAt: string;
  chatDir: string;
  workspace?: { cwd: string; strategy: string };
  chatDigest?: ChatDigest;
  existingPlans?: ExistingPlanSummary[];
  preferences?: string;
  language?: string;
};

export function buildDiscoveryPrompt(input: BuildDiscoveryPromptInput): string {
  if (input.language === "zh-CN") return buildDiscoveryPromptZh(input);
  const rootPath = input.workspace?.cwd ?? input.projectRoot;
  const lines: string[] = [
    `You are running an autonomous project discovery task for: ${rootPath}`,
    "",
    "Goal: identify AT MOST ONE worthwhile task to propose.",
    "",
    "Discovery process:",
    "1. First understand the project's nature, domain, and the user's work objectives (browse directory structure and key files).",
    "2. Combine chat history and project context to anticipate user needs and uncover latent tasks worth pursuing.",
    "",
    "When multiple potential tasks exist, prefer those that substantively advance the user's core work objectives",
    "over superficial fixes, formatting polish, or minor corrections.",
    "Think from the user's perspective: if they had a proactive assistant, what kind of work would they most want it to push forward?",
    "",
    "Only skip proposing a plan if the project is empty or truly has nothing to improve.",
  ];

  lines.push("", ...formatChatDigestSection(input.chatDigest));
  lines.push("", ...formatExistingPlansSection(input.existingPlans));
  lines.push("", ...formatPreferencesSection(input.preferences));

  lines.push(
    "",
    `If you identify a task, call \`${ALWAYS_ON_PLAN_TOOL_NAME}\` exactly once with a strictly-formatted markdown plan.`,
    "Required plan structure (top to bottom):",
    "  - Level-1 heading: # <plan title>",
    "  - Metadata blockquote, first line `Always-On Discovery Plan`, then keyed lines:",
    `    > id: plan_${input.runId}`,
    `    > sourceRunId: ${input.runId}`,
    `    > createdAt: ${input.createdAt}`,
    `    > projectRoot: ${input.projectRoot}`,
    "  - Sections in this exact order: ## Summary, ## Rationale, ## Context Signals, ## Proposed Change, ## Execution Steps, ## Verification.",
    "  - Summary ≤ 200 chars, single paragraph.",
    "  - Context Signals: at least one `-` bullet.",
    "  - Execution Steps: ordered list (1., 2., …) only; no bullets.",
    "  - Verification: at least one `-` bullet, each line must be machine-checkable.",
    "",
    "Hard constraints:",
    `  - Calling \`${ALWAYS_ON_PLAN_TOOL_NAME}\` more than once returns plan_quota_exhausted.`,
    "  - Plans missing or reordering required sections, or containing fuzzy 'TODO' wording, will be rejected.",
    "  - Do not include Risks or Rollback sections.",
  );

  return lines.join("\n");
}

function formatChatDigestSection(digest?: ChatDigest): string[] {
  if (!digest || digest.sessions.length === 0) {
    return [
      "No recent user conversations found. Explore the project deeply to understand its purpose, and prioritize tasks that substantively advance its core direction over minor fixes.",
    ];
  }

  const lines: string[] = [
    "## Recent user conversations",
    "",
    "Below is a structured digest of recent user-agent chat sessions.",
    "These may reveal the user's deeper goals, priorities, and direction of work — not just short-term to-dos.",
    `To see the full conversation of a session, call \`${ALWAYS_ON_CHAT_HISTORY_TOOL_NAME}\` with its sessionId.`,
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

function formatPreferencesSection(preferences?: string): string[] {
  if (!preferences?.trim()) return [];
  return [
    "## User preferences",
    "",
    "The following preferences were learned from past plan outcomes.",
    "Avoid proposing tasks aligned with rejected preferences, but do not confine yourself to previously accepted types —",
    "maintain freedom to explore and surface needs the user may not yet be aware of.",
    "",
    preferences.trim(),
  ];
}

function formatExistingPlansSection(plans?: ExistingPlanSummary[]): string[] {
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
    lines.push(
      "## Pending accumulated plans (completed but not yet applied or archived -- do NOT duplicate these topics)",
      "",
    );
    for (const plan of active) {
      lines.push(`- "${plan.title}"`);
      if (plan.summary) lines.push(`  Summary: ${plan.summary}`);
    }
  }

  if (applied.length > 0) {
    lines.push(
      "",
      "## Plans the user has accepted and applied to the project (do NOT duplicate these topics)",
      "",
    );
    for (const plan of applied) {
      lines.push(`- "${plan.title}"`);
      if (plan.summary) lines.push(`  Summary: ${plan.summary}`);
    }
  }

  if (dismissed.length > 0) {
    lines.push(
      "",
      "## Plans rejected or abandoned by the user",
      "",
      "These plans were rejected or abandoned by the user, or failed during execution.",
      "Do not propose the exact same approach,",
      "but if the direction is still valuable, you may re-propose with a different angle or improved approach.",
      "",
    );
    for (const plan of dismissed) {
      lines.push(`- "${plan.title}"`);
      if (plan.summary) lines.push(`  Summary: ${plan.summary}`);
    }
  }

  return lines;
}
