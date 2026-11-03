/** Reusable Leader, Teammate, and Team configuration. */
export type ProfileRole = "leader" | "teammate";
export type TeamModel = { mode: "model"; provider: string; model: string; reasoning?: number; speed?: number };
export type ProfileConfig = {
  displayName: string;
  description: string;
  systemPrompt: string;
  model: { mode: "default" } | TeamModel;
  workspace: { mode: "team" } | { mode: "fixed"; projectKey: string };
  capabilities: { tools: string[]; skills: string[]; mcpServers: string[] };
  permissionMode: "default" | "plan" | "bypassPermissions";
};
/** A configuration identity. Profiles and Teams are latest-only records. */
export type ProfileRef = { id: string };
export type AgentProfile = ProfileRef & {
  role: ProfileRole;
  config: ProfileConfig;
  createdAt: string;
  updatedAt: string;
};
export type TeamConfig = {
  displayName: string;
  description: string;
  instructions: string;
  defaultProjectKey: string | null;
  leader: ProfileRef;
  teammates: ProfileRef[];
};
export type TeamDefinition = {
  id: string;
  config: TeamConfig;
  leader: AgentProfile;
  teammates: AgentProfile[];
  createdAt: string;
  updatedAt: string;
};
export type TeamInventory = {
  tools: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description?: string }>;
  mcpServers: Array<{ name: string; description?: string }>;
};
export type TeamLibrary = { profiles: AgentProfile[]; teams: TeamDefinition[] };
export type TeamLibraryCommand =
  | { action: "library" }
  | { action: "inventory"; projectKey?: string }
  | { action: "profile_save"; id?: string; role: ProfileRole; config: ProfileConfig; requestToken: string }
  | { action: "profile_fork"; source: ProfileRef; displayName?: string; requestToken: string }
  | { action: "profile_delete"; id: string; requestToken: string }
  | { action: "team_save"; id?: string; config: TeamConfig; requestToken: string }
  | { action: "team_fork"; source: ProfileRef; displayName?: string; requestToken: string }
  | { action: "team_delete"; id: string; requestToken: string }
  | { action: "project_references"; projectKey: string };
export type TeamLibraryCommandResult = TeamLibrary | TeamInventory | AgentProfile | TeamDefinition | { referenced: boolean };
export type TeamCommand = TeamLibraryCommand | import('./runtimeTypes.js').TeamRuntimeCommand;
export type TeamCommandResult = TeamLibraryCommandResult | import('./runtimeTypes.js').TeamRuntimeCommandResult;
export type TeamServiceOptions = {
  pilotHome: string;
  inventory: (projectKey?: string) => Promise<TeamInventory>;
  validateTeammateWorkspace?: (projectKey: string) => Promise<void>;
};
