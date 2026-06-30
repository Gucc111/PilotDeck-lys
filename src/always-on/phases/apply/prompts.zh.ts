import type { BuildApplyPromptInput } from "./prompts.js";

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
