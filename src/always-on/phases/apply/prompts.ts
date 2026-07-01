import { buildApplyPromptZh } from "./prompts.zh.js";

export type BuildApplyPromptInput = {
  workspaceCwd: string;
  baseCommit: string;
  isProjectGit: boolean;
  changedFiles: Array<{ status: string; path: string; oldPath?: string }>;
  programmaticApplyError?: {
    command: string;
    error?: string;
    stdout?: string;
    stderr?: string;
  };
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
    if (input.programmaticApplyError) {
      lines.push(
        "PilotDeck already tried to apply the cumulative diff programmatically, but it failed.",
        "You are the fallback merger. Do not blindly rerun the same command; inspect the affected files and apply the changes manually when needed.",
        "",
        "Failed command:",
        `  ${input.programmaticApplyError.command}`,
        "",
        "Failure output:",
        input.programmaticApplyError.error || input.programmaticApplyError.stderr || input.programmaticApplyError.stdout || "(no output)",
        "",
        "Inspect individual file diffs from the isolated workspace and edit the project files directly:",
        `  git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
        "Do NOT use git merge / git cherry-pick / git am, and do NOT create commits.",
      );
    } else {
      lines.push(
        "Run the following command to apply the changes:",
        "",
        `  git -C ${workspaceCwd} diff ${baseCommit} HEAD --binary --find-renames | git apply`,
        "",
        "If the command fails, inspect individual files from the list above and edit manually:",
        `  git -C ${workspaceCwd} diff ${baseCommit} HEAD -- <file>`,
        "Do NOT use git merge / git cherry-pick / git am or any command that produces commits.",
      );
    }
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
