import type { DiscoveryPlanRecord } from "../protocol/types.js";
import type { WorkspaceDiff } from "../workspace/WorkspaceApply.js";
import type { ChatDigest } from "../context/ChatDigestBuilder.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../tool/AlwaysOnWorkspaceTool.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../tool/AlwaysOnChatHistoryTool.js";
import {
  buildDiscoveryPromptZh,
  buildWorkspacePromptZh,
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

export type BuildWorkspacePromptInput = {
  projectRoot: string;
  runId: string;
  planTitle: string;
  language?: string;
};

export function buildWorkspacePrompt(input: BuildWorkspacePromptInput): string {
  if (input.language === "zh-CN") return buildWorkspacePromptZh(input);
  return [
    "You are preparing an isolated workspace for an Always-On plan execution.",
    "",
    `Project root: ${input.projectRoot}`,
    `Plan: "${input.planTitle}"`,
    "",
    "Available workspace strategies:",
    "  - `git-worktree`: Creates a git worktree on a new branch. Fast and space-efficient (hard-links).",
    "    Requires a git repo with at least one commit. If the working tree is dirty, Always-On",
    "    checkpoints all current changes before creating the worktree.",
    "  - `snapshot-copy`: Copies the project directory (CoW on APFS/btrfs). Works for any directory",
    "    but uses more disk space. Ignores .git, node_modules, dist by default.",
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## What to do",
    "1. Check the project root state (e.g. `git status --porcelain` if it looks like a git repo, or `ls` otherwise).",
    `2. Call \`${ALWAYS_ON_WORKSPACE_TOOL_NAME}\` with the chosen strategy, or \`auto\` to let the runtime decide.`,
  ].join("\n");
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
  plan: { title: string; id: string; workspace?: { cwd: string; strategy: string } };
  selectedPlanIds?: string[];
  selectedCommitShas?: string[];
  commitScoped?: boolean;
  isProjectGit?: boolean;
  changedFiles?: Array<{ status: string; path: string; oldPath?: string }>;
  projectName: string;
  projectRoot: string;
  diff: WorkspaceDiff;
  branchName?: string;
  language?: string;
};

export function buildApplyPrompt(input: BuildApplyPromptInput): string {
  if (input.language === "zh-CN") return buildApplyPromptZh(input);
  const { plan, projectName, projectRoot, diff, branchName } = input;

  const lines: string[] = [
    `Always-On apply for project "${projectName}".`,
    "",
    "Your job is to merge changes from the isolated workspace into the project root.",
    "",
    "Do not enter Plan Mode.",
    "Do not create a new plan — apply the existing changes directly.",
    "",
    `Plan: "${plan.title}" (${plan.id})`,
    `Project root: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    lines.push(`Isolated workspace: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  if (branchName) {
    lines.push(`Workspace branch: ${branchName}`);
  }

  if (input.commitScoped) {
    lines.push(
      "",
      "Selected plan ids:",
      ...(input.selectedPlanIds?.length ? input.selectedPlanIds.map((id) => `  - ${id}`) : ["  - none"]),
      "",
      "Selected execution commits, in apply order:",
      ...(input.selectedCommitShas?.length ? input.selectedCommitShas.map((sha) => `  - ${sha}`) : ["  - no-op execution"]),
    );
  }

  lines.push("", "## Merge approach", "");

  if (input.isProjectGit !== undefined) {
    if (input.isProjectGit) {
      lines.push(
        "Below is the cumulative diff from the isolated workspace relative to the baseCommit.",
        "The diff context lines are based on baseCommit, which matches your workspace's current state.",
        "",
        "Recommended approach:",
        "1. Save the diff below to a temporary file",
        "2. Run `git apply <patch-file>` in the project root directory",
        "3. Do NOT commit — only modify the working tree, let the user decide whether to commit",
        "",
        "Notes:",
        "- Use `git apply` (without --3way) — it only modifies working tree files, no commits",
        "- If apply fails, use Edit/Write tools to manually edit the corresponding files based on the diff",
        "- Do NOT use git merge / git cherry-pick / git am or any other command that produces commits",
        "",
      );
    } else {
      lines.push(
        "Below is the changed file list and diff from the isolated workspace relative to its initial state.",
        "",
        "Recommended approach:",
        "1. For added/modified files: read the file content from the isolated workspace",
        `   (${plan.workspace?.cwd ?? "workspace"}), then write it to the corresponding path under project root (${projectRoot})`,
        "2. For deleted files: delete the corresponding file in the project root directory",
        "3. Use the Read tool to read files from the isolated workspace, and the Write tool to write to the project root",
        "",
        `Do NOT use any git commands on the project root directory (it is not a git repository).`,
        "",
      );

      if (input.changedFiles?.length) {
        lines.push("Changed files:");
        for (const f of input.changedFiles) {
          if (f.status === "R") {
            lines.push(`  - [Renamed] ${f.oldPath} → ${f.path}`);
          } else if (f.status === "A") {
            lines.push(`  - [Added] ${f.path}`);
          } else if (f.status === "D") {
            lines.push(`  - [Deleted] ${f.path}`);
          } else {
            lines.push(`  - [Modified] ${f.path}`);
          }
        }
        lines.push("");
      }
    }
  } else if (input.commitScoped) {
    lines.push(
      "Apply only the selected execution patch included below.",
      "Do not merge the isolated workspace branch or inspect/apply changes belonging to unselected plans.",
      "",
      "Choose the best merge strategy based on the situation. You have full access to git and shell tools.",
      "Use the supplied patch as the source of truth. Apply it with git or reproduce it through precise file edits.",
      "",
    );
  } else {
    lines.push(
      "Choose the best merge strategy based on the situation. You have full access to git and shell tools.",
      "Common approaches (pick whichever fits):",
      "  - `git merge` / `git merge --no-ff` if the workspace is on a named branch",
      "  - `git cherry-pick` for individual commits",
      "  - `git diff` + `git apply` for patch-based application",
      "  - Direct file edits via Edit/Write tools for surgical changes",
      "",
    );
  }

  if (input.isProjectGit === undefined) {
    lines.push(
      "If you encounter conflicts, resolve them intelligently — do not blindly overwrite.",
      "If you cannot resolve a conflict, leave standard conflict markers (<<<< / ==== / >>>>).",
      "",
    );
  }

  if (!diff.diff.trim()) {
    lines.push("No differences detected in the workspace. Nothing to apply.");
    return lines.join("\n");
  }

  if (diff.truncated) {
    lines.push(
      `The diff is large (${diff.fileCount} files) and has been truncated.`,
      "Read the relevant files from the workspace directory to compare and apply.",
      "",
      "Truncated diff (first portion):",
      "",
      diff.diff,
    );
  } else {
    lines.push(
      `Changes (${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"}):`,
      "",
      diff.diff,
    );
  }

  return lines.join("\n");
}
