import { resolve } from "node:path";
import { resolveProjectStorageId } from "../../../pilot/paths.js";

const ROOT_DIR_NAME = "always-on";

export type AlwaysOnPaths = {
  pilotHome: string;
  projectKey: string;
  projectId: string;
  rootDir: string;
  projectDir: string;
  stateFile: string;
  plansDir: string;
  planIndexFile: string;
  cyclesDir: string;
  cycleIndexFile: string;
  reportsDir: string;
  eventsFile: string;
  locksDir: string;
  discoveryLockFile: string;
  worktreesDir: string;
  snapshotsDir: string;
  memoryDir: string;
  preferenceEventsFile: string;
  preferencesFile: string;
};

export function resolveAlwaysOnPaths(input: {
  pilotHome: string;
  projectKey: string;
}): AlwaysOnPaths {
  const pilotHome = resolve(input.pilotHome);
  const projectKey = resolve(input.projectKey);
  const projectId = resolveProjectStorageId(projectKey, pilotHome);
  const rootDir = resolve(pilotHome, ROOT_DIR_NAME);
  const projectDir = resolve(rootDir, "projects", projectId);
  const worktreesDir = resolve(rootDir, "worktrees", projectId);
  const snapshotsDir = resolve(rootDir, "snapshots", projectId);
  const memoryDir = resolve(projectDir, "memory");

  return {
    pilotHome,
    projectKey,
    projectId,
    rootDir,
    projectDir,
    stateFile: resolve(projectDir, "state.json"),
    plansDir: resolve(projectDir, "plans"),
    planIndexFile: resolve(projectDir, "plans", "index.json"),
    cyclesDir: resolve(projectDir, "cycles"),
    cycleIndexFile: resolve(projectDir, "cycles", "index.json"),
    reportsDir: resolve(projectDir, "reports"),
    eventsFile: resolve(projectDir, "events.jsonl"),
    locksDir: resolve(projectDir, "locks"),
    discoveryLockFile: resolve(projectDir, "locks", "discovery.lock"),
    worktreesDir,
    snapshotsDir,
    memoryDir,
    preferenceEventsFile: resolve(memoryDir, "preference-events.jsonl"),
    preferencesFile: resolve(memoryDir, "preferences.md"),
  };
}

export function planMarkdownPath(paths: AlwaysOnPaths, title: string, uid: string): string {
  return resolve(paths.plansDir, `${sanitizeId(title)}--${sanitizeId(uid)}.md`);
}

export function reportMarkdownPath(paths: AlwaysOnPaths, runId: string): string {
  return resolve(paths.reportsDir, `${sanitizeId(runId)}.md`);
}

/**
 * Strip the `--<uid>` suffix from a plan file path so the raw uid
 * is never exposed to the agent / LLM.
 */
export function stripPlanUidFromFilename(filePath: string): string {
  return filePath.replace(/--[A-Za-z0-9._-]+\.md$/, ".md");
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

