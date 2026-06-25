export type AlwaysOnTriggerConfig = {
  enabled: boolean;
  tickIntervalMinutes: number;
  cooldownMinutes: number;
  dailyBudget: number;
  heartbeatStaleSeconds: number;
  recentUserMsgMinutes: number;
  preferChannel: string;
};

export type AlwaysOnDormancyConfig = {
  debounceMs: number;
  ignoreGlobs: string[];
};

export type AlwaysOnWorkspaceConfig = {
  snapshotMaxBytes: number;
  maxPlansPerCycle: number;
};

export type AlwaysOnMemoryConfig = {
  extractionThreshold: number;
  consolidationThreshold: number;
};

export type AlwaysOnProjectConfig = {
  enabled: boolean;
};

export type AlwaysOnPromptLanguage = "en" | "zh-CN";

export type AlwaysOnConfig = {
  enabled: boolean;
  language?: AlwaysOnPromptLanguage;
  trigger: AlwaysOnTriggerConfig;
  dormancy: AlwaysOnDormancyConfig;
  workspace: AlwaysOnWorkspaceConfig;
  memory: AlwaysOnMemoryConfig;
  projects: Record<string, AlwaysOnProjectConfig>;
};
