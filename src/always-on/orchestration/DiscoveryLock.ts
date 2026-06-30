import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AlwaysOnPaths } from "../infra/storage/AlwaysOnPaths.js";

export async function acquireDiscoveryLock(
  paths: AlwaysOnPaths,
  payload: { pid: number; startedAt: string; runId: string },
): Promise<boolean> {
  await mkdir(dirname(paths.discoveryLockFile), { recursive: true });
  try {
    await writeFile(paths.discoveryLockFile, JSON.stringify(payload, null, 2), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function releaseDiscoveryLock(paths: AlwaysOnPaths): Promise<void> {
  await unlink(paths.discoveryLockFile).catch(() => undefined);
}
