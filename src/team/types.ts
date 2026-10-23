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
  optionalCapabilities: Array<{ kind: "tool" | "skill" | "mcp"; name: string }>;
  permissionMode: "default" | "plan" | "bypassPermissions";
};
export type ProfileRef = { id: string; revision: number };
export type AgentProfile = ProfileRef & {
  role: ProfileRole;
  config: ProfileConfig;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  forkedFrom?: ProfileRef;
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
  revision: number;
  config: TeamConfig;
  leader: AgentProfile;
  teammates: AgentProfile[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  forkedFrom?: ProfileRef;
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
  | { action: "profile_save"; id?: string; expectedRevision?: number; role: ProfileRole; config: ProfileConfig; requestToken: string }
  | { action: "profile_fork"; source: ProfileRef; displayName?: string; requestToken: string }
  | { action: "profile_archive"; id: string; expectedRevision: number; archived: boolean }
  | { action: "team_save"; id?: string; expectedRevision?: number; config: TeamConfig; requestToken: string }
  | { action: "team_fork"; source: ProfileRef; displayName?: string; requestToken: string }
  | { action: "team_archive"; id: string; expectedRevision: number; archived: boolean }
  | { action: "project_references"; projectKey: string };
export type TeamLibraryCommandResult = TeamLibrary | TeamInventory | AgentProfile | TeamDefinition | { referenced: boolean };
export type TeamCommand = TeamLibraryCommand | import('./runtimeTypes.js').TeamRuntimeCommand;
export type TeamCommandResult = TeamLibraryCommandResult | import('./runtimeTypes.js').TeamRuntimeCommandResult;
export type TeamServiceOptions = {
  pilotHome: string;
  inventory: (projectKey?: string) => Promise<TeamInventory>;
};
