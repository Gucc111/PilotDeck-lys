import type { DiscoveryPlanRecord } from "../protocol/types.js";
import type { ChatDigest } from "../context/ChatDigestBuilder.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../tool/AlwaysOnChatHistoryTool.js";
import {
  buildDiscoveryPromptZh,
  buildExecutionPromptZh,
  buildReportPromptZh,
  buildApplyPromptZh,
} from "./discoveryPrompts.zh.js";

export type ExistingPlanSummary = {
  id: string;
  title: string;
  summary?: string;
  dedupeKey: string;
  status: string;
};

export type BuildDiscoveryPromptInput = {
  projectRoot: string;
  runId: string;
  /** ISO timestamp the runtime should embed in the plan metadata. */
  createdAt: string;
  /** Absolute path of the project's PilotDeck chat transcript directory. */
  chatDir: string;
  /** When an isolated workspace from a previous run still exists on disk, discovery runs inside it. */
  workspace?: { cwd: string; strategy: string };
  /** Pre-built digest of recent user chat sessions. */
  chatDigest?: ChatDigest;
  /** Summaries of previously created Always-On plans. */
  existingPlans?: ExistingPlanSummary[];
  /** Learned user preferences from past plan outcomes. */
  preferences?: string;
  /** Prompt language override. Defaults to English when absent. */
  language?: string;
};

export function buildDiscoveryPrompt(input: BuildDiscoveryPromptInput): string {
  if (input.language === "zh-CN") return buildDiscoveryPromptZh(input);
  const rootPath = input.workspace?.cwd ?? input.projectRoot;
  const headerLine = `You are running an autonomous Always-On discovery for project: ${rootPath}`;

  const lines: string[] = [
    headerLine,
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
    "    > dedupeKey: <stable identifier>",
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
    "## Always-On user preferences",
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
      lines.push(`- [${plan.status}] "${plan.title}"`);
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
      lines.push(`- [${plan.status}] "${plan.title}"`);
      if (plan.summary) lines.push(`  Summary: ${plan.summary}`);
    }
  }

  return lines;
}

export type BuildExecutionPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  language?: string;
};

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  if (input.language === "zh-CN") return buildExecutionPromptZh(input);
  return [
    `You are executing an Always-On discovery plan inside an isolated workspace.`,
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "Safety boundary is the workspace itself; do NOT cd outside it, do NOT touch the user's project root.",
    "",
    "## Plan",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Execute the Execution Steps in order.",
    "2. Run the Verification list and record results.",
    "3. Before responding, run `git status --porcelain` in the isolated workspace.",
    "4. If there are local changes, run `git add -A` and commit them with a concise message.",
    "5. Respond with a summary of what was done and the verification outcomes.",
  ].join("\n");
}

export type BuildReportPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  executionCommitShas?: string[];
  language?: string;
};

export function buildReportPrompt(input: BuildReportPromptInput): string {
  if (input.language === "zh-CN") return buildReportPromptZh(input);
  return [
    "You are writing a work report for a completed Always-On plan execution.",
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## Plan that was executed",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    ...(input.executionCommitShas?.length
      ? [
          `1. Review the execution commits with \`git show --stat ${input.executionCommitShas.join(" ")}\` and inspect relevant files.`,
        ]
      : [
          "1. Review the workspace to see what changed (e.g. `git diff --stat`, `ls`, read relevant files).",
        ]),
    "2. Summarize the execution: what steps were performed, which files were changed, command outputs, and verification results.",
    `3. Call \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the full work-report markdown.`,
    "",
    "Each section MUST use `##` (h2) headers — e.g. `## Plan Reference`, `## Steps Performed`, etc.",
    "Required sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}

export type BuildApplyPromptInput = {
  workspaceCwd: string;
  baseCommit: string;
  isProjectGit: boolean;
  changedFiles: Array<{ status: string; path: string; oldPath?: string }>;
  projectRoot: string;
  language?: string;
};

export function buildApplyPrompt(input: BuildApplyPromptInput): string {
  if (input.language === "zh-CN") return buildApplyPromptZh(input);
  const { workspaceCwd, baseCommit, projectRoot, changedFiles } = input;

  const lines: string[] = [
    "Merge a set of file changes from the isolated workspace into the project directory.",
    "",
    `Working directory (cwd): ${projectRoot}`,
    `Isolated workspace: ${workspaceCwd}`,
    `Base commit: ${baseCommit}`,
  ];

  if (changedFiles.length === 0) {
    lines.push("", "No file changes detected. Nothing to apply.");
    return lines.join("\n");
  }

  lines.push("", "## Merge approach", "");
  lines.push(...formatChangedFileList(changedFiles, input.isProjectGit));

  if (input.isProjectGit) {
    lines.push(
      "Run the following command to apply the changes:",
      "",
      `  git -C ${workspaceCwd} diff ${baseCommit} HEAD --binary --find-renames | git apply`,
      "",
      "If the command fails, inspect individual files from the list above and edit manually:",
      `  git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
      "Do NOT use git merge / git cherry-pick / git am or any command that produces commits.",
    );
  } else {
    lines.push(
      "Complete the merge based on the file list above:",
      `- Added/modified files: cp ${workspaceCwd}/<path> ./<path> (mkdir -p the parent directory first if needed)`,
      "- Deleted files: rm ./<path>",
      "- Renamed files: cp to the new path and rm the old path",
      "- You may batch multiple commands into a single shell call",
      `- To inspect a specific file's diff: git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
      "",
      "Do NOT use any git commands on the project directory (it is not a git repository).",
    );
  }

  return lines.join("\n");
}

function formatChangedFileList(
  files: Array<{ status: string; path: string; oldPath?: string }>,
  isGit: boolean,
): string[] {
  const label = isGit
    ? "Changed files relative to base commit:"
    : "Changed files relative to initial state:";
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
