import { spawn } from "node:child_process";
import { GitCommandError } from "./errors.js";
import type {
  GitCommandResult,
  ProcessCommandResult,
  RunGitOptions,
  RunProcessOptions,
} from "./types.js";

export async function runProcess(
  bin: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessCommandResult> {
  return new Promise<ProcessCommandResult>((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  return runProcess(options.gitBin ?? "git", ["-C", cwd, ...args], {
    stdin: options.stdin,
  });
}

export async function isGitAvailable(cwd: string, gitBin = "git"): Promise<boolean> {
  const result = await runGit(cwd, ["--version"], { gitBin }).catch(() => undefined);
  return !!result && result.exitCode === 0;
}

export function expectGitOk(result: GitCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new GitCommandError(label, result);
  }
}
