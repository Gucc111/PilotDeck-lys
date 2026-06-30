import type { GitCommandResult } from "./types.js";

export class GitCommandError extends Error {
  readonly result: GitCommandResult;

  constructor(label: string, result: GitCommandResult) {
    super(`${label} failed: ${result.stderr || result.stdout}`);
    this.name = "GitCommandError";
    this.result = result;
  }
}
