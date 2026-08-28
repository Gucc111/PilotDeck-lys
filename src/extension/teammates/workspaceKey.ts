import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { findCanonicalProjectRoot } from "../../session/worktree/findCanonicalProjectRoot.js";

export async function canonicalizeWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new Error("workspace is required.");
  }
  const canonical = await findCanonicalProjectRoot(resolve(workspace));
  let physicalPath: string;
  try {
    physicalPath = await realpath(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    physicalPath = resolve(canonical);
  }
  return normalizeWorkspaceKey(physicalPath);
}

export function normalizeWorkspaceKey(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(workspace).normalize("NFC");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
