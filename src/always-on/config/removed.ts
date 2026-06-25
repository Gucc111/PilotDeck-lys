export const REMOVED_TOP_LEVEL_KEYS: Record<string, string> = {
  discovery:
    "alwaysOn.discovery wrapper has been removed. Lift trigger / dormancy / workspace / projects to alwaysOn.<key>.",
  plan: "alwaysOn.plan section has been removed. plan-per-fire is fixed at 1 by protocol.",
  cron: "Always-On cron is no longer part of this module.",
  execution:
    "alwaysOn.execution section has been removed. Execution limits are controlled by the Gateway/Agent runtime.",
};

export const REMOVED_DORMANCY_KEYS: Record<string, string> = {
  enabled:
    "alwaysOn.dormancy.enabled has been removed. Dormancy is always active.",
};

export const REMOVED_WORKSPACE_KEYS: Record<string, string> = {
  strategy:
    "alwaysOn.workspace.strategy has been removed. WorkspaceProviderRegistry selects the strategy automatically.",
  maxConcurrentEnvs:
    "alwaysOn.workspace.maxConcurrentEnvs has been removed. Always-On runs at most one isolated workspace per project; subsequent fires reuse it.",
  retainSuccessfulEnvs:
    "alwaysOn.workspace.retainSuccessfulEnvs has been removed. Workspaces are always retained for manual inspection.",
  retainFailedEnvs:
    "alwaysOn.workspace.retainFailedEnvs has been removed. Workspaces are always retained for manual inspection.",
  gitWorktreeBaseDir:
    "alwaysOn.workspace.gitWorktreeBaseDir has been removed. Worktree base is fixed at <pilotHome>/always-on/worktrees.",
  snapshotBaseDir:
    "alwaysOn.workspace.snapshotBaseDir has been removed. Snapshot base is fixed at <pilotHome>/always-on/snapshots.",
  gitLfs:
    "alwaysOn.workspace.gitLfs has been removed. Git LFS handling is not supported.",
};

export const REMOVED_MEMORY_KEYS: Record<string, string> = {
  enabled:
    "alwaysOn.memory.enabled has been removed. Preference memory is always active.",
};

export const REMOVED_PROJECT_KEYS: Record<string, string> = {
  sessionKey:
    "alwaysOn.projects.<root>.sessionKey is no longer accepted. The runtime derives sessionKey from projectKey + runId.",
  workspace:
    "alwaysOn.projects.<root>.workspace per-project override is no longer accepted. WorkspaceProviderRegistry resolves provider automatically.",
};
