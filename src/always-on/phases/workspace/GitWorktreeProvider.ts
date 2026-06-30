import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runGit, type GitCommandResult } from "../../infra/git/index.js";
import { AlwaysOnError } from "../../infra/errors.js";
import type { WorkspaceHandle } from "../../infra/storage/types.js";
import type { WorkspaceProvider, WorkspacePrepareInput, WorkspacePublishOutput } from "./WorkspaceProvider.js";

export type GitWorktreeProviderOptions = {
  baseDir: string;
  /** @deprecated Dirty worktrees are now checkpointed automatically. */
  refuseDirty?: boolean;
  /** Override `git` executable path (tests). */
  gitBin?: string;
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
};

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly id = "git-worktree" as const;
  readonly priority = 1;

  constructor(private readonly options: GitWorktreeProviderOptions) {}

  async isApplicable(projectRoot: string): Promise<boolean> {
    const top = await runGit(projectRoot, ["rev-parse", "--show-toplevel"], { gitBin: this.git() }).catch(() => undefined);
    if (!top || top.exitCode !== 0) return false;
    const head = await runGit(projectRoot, ["rev-parse", "HEAD"], { gitBin: this.git() }).catch(() => undefined);
    if (!head || head.exitCode !== 0) return false;
    return true;
  }

  async prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle> {
    const top = await runGit(input.projectRoot, ["rev-parse", "--show-toplevel"], { gitBin: this.git() });
    expectOk(top, "git rev-parse --show-toplevel");
    const repoRoot = top.stdout.trim();
    await this.checkpointDirtyWorktree(repoRoot, input.planTitle);

    const branchRes = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { gitBin: this.git() });
    expectOk(branchRes, "git rev-parse --abbrev-ref HEAD");
    const baseBranch = branchRes.stdout.trim();
    const commitRes = await runGit(repoRoot, ["rev-parse", "HEAD"], { gitBin: this.git() });
    expectOk(commitRes, "git rev-parse HEAD");
    const baseCommit = commitRes.stdout.trim();

    const worktreePath = resolve(this.options.baseDir, input.runId);
    const branchName = `always-on/${input.runId}`;
    const add = await runGit(repoRoot, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      baseCommit,
    ]);
    if (add.exitCode !== 0) {
      throw new AlwaysOnError(
        "workspace_prepare_failed",
        `git worktree add failed: ${add.stderr || add.stdout}`,
        { repoRoot, worktreePath },
      );
    }

    this.options.onWorktreeCreated?.(input.runId, worktreePath);
    return {
      runId: input.runId,
      projectKey: input.projectRoot,
      strategy: this.id,
      cwd: worktreePath,
      metadata: { repoRoot, baseBranch, baseCommit, branchName },
    };
  }

  async publish(handle: WorkspaceHandle): Promise<WorkspacePublishOutput> {
    const repoRoot = handle.metadata.repoRoot ?? handle.cwd;
    const diff = await runGit(handle.cwd, ["diff", "--stat"], { gitBin: this.git() }).catch(() => undefined);
    return {
      diff: diff && diff.exitCode === 0 ? diff.stdout : undefined,
      commit: undefined,
      // intentionally do not push or commit; caller can layer that on later.
      ...(repoRoot ? {} : {}),
    };
  }

  async dispose(handle: WorkspaceHandle, options: { keep: boolean }): Promise<void> {
    if (options.keep) return;
    this.options.onWorktreeRemoved?.(handle.cwd);
    const repoRoot = handle.metadata.repoRoot ?? handle.cwd;
    const remove = await runGit(repoRoot, [
      "worktree",
      "remove",
      "--force",
      handle.cwd,
    ], { gitBin: this.git() }).catch(() => undefined);
    if (!remove || remove.exitCode !== 0) {
      await rm(handle.cwd, { recursive: true, force: true });
      await runGit(repoRoot, ["worktree", "prune"], { gitBin: this.git() }).catch(() => undefined);
    }
    const branchName = handle.metadata.branchName as string | undefined;
    if (branchName) {
      await runGit(repoRoot, ["branch", "-D", branchName], { gitBin: this.git() }).catch(() => undefined);
    }
  }

  private git(): string {
    return this.options.gitBin ?? "git";
  }

  private async checkpointDirtyWorktree(repoRoot: string, planTitle: string): Promise<void> {
    const status = await runGit(repoRoot, ["status", "--porcelain"], { gitBin: this.git() });
    expectOk(status, "git status --porcelain");
    if (!status.stdout.trim()) return;

    const add = await runGit(repoRoot, ["add", "-A"], { gitBin: this.git() });
    expectOk(add, "git add -A");

    const normalizedTitle = planTitle.replace(/\s+/g, " ").trim() || "untitled plan";
    const commit = await runGit(repoRoot, [
      "commit",
      "-m",
      `chore(always-on): checkpoint before executing ${normalizedTitle}`,
    ], { gitBin: this.git() });
    expectOk(commit, "git commit");

    const cleanStatus = await runGit(repoRoot, ["status", "--porcelain"], { gitBin: this.git() });
    expectOk(cleanStatus, "git status --porcelain");
    if (cleanStatus.stdout.trim()) {
      throw new AlwaysOnError(
        "workspace_prepare_failed",
        "git worktree remained dirty after the Always-On checkpoint commit.",
        { repoRoot },
      );
    }
  }
}

function expectOk(result: GitCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new AlwaysOnError(
      "workspace_prepare_failed",
      `${label} failed: ${result.stderr || result.stdout}`,
    );
  }
}
