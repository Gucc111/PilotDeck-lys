import type { AlwaysOnConfig } from "./types.js";

export const DEFAULT_IGNORE_GLOBS: string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.pilotdeck/**",
  "**/.pilotdeck-always-on/**",
  "**/dist/**",
  "**/.DS_Store",
];

const DEFAULT_SNAPSHOT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

export function defaultAlwaysOnConfig(): AlwaysOnConfig {
  return {
    enabled: false,
    trigger: {
      enabled: false,
      tickIntervalMinutes: 5,
      cooldownMinutes: 60,
      dailyBudget: 4,
      heartbeatStaleSeconds: 90,
      recentUserMsgMinutes: 5,
      preferChannel: "web",
    },
    dormancy: {
      debounceMs: 2000,
      ignoreGlobs: [...DEFAULT_IGNORE_GLOBS],
    },
    workspace: {
      snapshotMaxBytes: DEFAULT_SNAPSHOT_MAX_BYTES,
      maxPlansPerCycle: 3,
    },
    memory: {
      extractionThreshold: 3,
      consolidationThreshold: 15,
    },
    projects: {},
  };
}
