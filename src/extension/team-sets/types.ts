import type { ToolCallSelector } from "../../permission/index.js";
import type { TeammateContextPolicy } from "../teammates/types.js";

export const TEAM_SET_SCHEMA_VERSION = 1 as const;
export const TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION = 1 as const;

export type TeamSetSchemaVersion = typeof TEAM_SET_SCHEMA_VERSION;
export type TeamSetWorkspaceAssignmentSchemaVersion =
  typeof TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Leader config within a Team Set
// ---------------------------------------------------------------------------

export type TeamSetLeaderToolProfile =
  | { mode: "inherit" }
  | { mode: "custom"; tools: string[] };

export type TeamSetLeaderConfig =
  | { mode: "inherit" }
  | {
      mode: "override";
      model?: string;
      maxContextTokens?: number;
      maxOutputTokens?: number;
      toolProfile?: TeamSetLeaderToolProfile;
      prompt?: string;
      plugins?: string[];
      skills?: string[];
      mcpServers?: string[];
    }
  | {
      mode: "standalone";
      model?: string;
      maxContextTokens?: number;
      maxOutputTokens?: number;
      tools: string[];
      plugins: string[];
      skills: string[];
      mcpServers: string[];
      prompt: string;
    };

// ---------------------------------------------------------------------------
// Teammate config within a Team Set
// ---------------------------------------------------------------------------

export type TeamSetTeammateToolConstraints = {
  allow: ToolCallSelector[];
  deny: ToolCallSelector[];
};

export type TeamSetTeammateToolProfile =
  | { mode: "inherit" }
  | {
      mode: "custom";
      tools: string[];
      constraints: TeamSetTeammateToolConstraints;
    };

export type TeamSetTeammateConfig = {
  toolProfile: TeamSetTeammateToolProfile;
  contextPolicy?: TeammateContextPolicy;
  modelOverride?: string;
  promptOverride?: string;
  maxContextTokensOverride?: number;
  maxOutputTokensOverride?: number;
};

// ---------------------------------------------------------------------------
// Team Set definition (one per JSON file)
// ---------------------------------------------------------------------------

export interface TeamSetDefinition {
  schemaVersion: TeamSetSchemaVersion;
  id: string;
  name: string;
  description?: string;
  leader: TeamSetLeaderConfig;
  teammates: Record<string, TeamSetTeammateConfig>;
}

// ---------------------------------------------------------------------------
// Workspace assignment document
// ---------------------------------------------------------------------------

export interface TeamSetWorkspaceAssignmentDocument {
  schemaVersion: TeamSetWorkspaceAssignmentSchemaVersion;
  workspaces: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Store options and error codes
// ---------------------------------------------------------------------------

export type TeamSetStoreOptions = {
  pilotHome: string;
};

export type TeamSetStoreErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "invalid_schema"
  | "not_found"
  | "duplicate_id"
  | "revision_conflict"
  | "unsafe_path";

// ---------------------------------------------------------------------------
// Gateway input/output types
// ---------------------------------------------------------------------------

export type TeamSetSummary = {
  id: string;
  name: string;
  description?: string;
  teammateCount: number;
  leaderMode: "inherit" | "override" | "standalone";
};

export type TeamSetListResult = {
  teamSets: TeamSetSummary[];
};

export type TeamSetReadInput = { id: string };
export type TeamSetReadResult = {
  teamSet: TeamSetDefinition;
  revision: string;
};

export type TeamSetCreateInput = {
  teamSet: Omit<TeamSetDefinition, "schemaVersion">;
};
export type TeamSetCreateResult = TeamSetReadResult;

export type TeamSetWriteInput = {
  id: string;
  teamSet: Omit<TeamSetDefinition, "schemaVersion">;
  expectedRevision: string;
};
export type TeamSetWriteResult = TeamSetReadResult;

export type TeamSetDeleteInput = { id: string };
export type TeamSetDeleteResult = { ok: true; id: string };

export type TeamSetWorkspaceAssignmentGetInput = { projectKey: string };
export type TeamSetWorkspaceAssignmentGetResult = {
  canonicalProjectKey: string;
  teamSetId: string | null;
  revision: string;
};

export type TeamSetWorkspaceAssignmentSetInput = {
  projectKey: string;
  teamSetId: string | null;
  expectedRevision: string;
};
export type TeamSetWorkspaceAssignmentSetResult =
  TeamSetWorkspaceAssignmentGetResult;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type TeamSetDiagnosticSeverity = "error" | "warning";

export type TeamSetDiagnosticCode =
  | "TEAM_SET_NOT_FOUND"
  | "TEAM_SET_INVALID"
  | "TEAMMATE_DEFINITION_MISSING"
  | "LEADER_CONFIG_INVALID"
  | "MODEL_NOT_FOUND"
  | "TOOL_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "MCP_SERVER_NOT_FOUND";

export interface TeamSetDiagnostic {
  code: TeamSetDiagnosticCode;
  severity: TeamSetDiagnosticSeverity;
  message: string;
  teamSetId?: string;
  teammateId?: string;
  field?: string;
}
