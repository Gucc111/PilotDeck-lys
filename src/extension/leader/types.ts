export const LEADER_SCHEMA_VERSION = 1 as const;
export const LEADER_OVERRIDE_SCHEMA_VERSION = 1 as const;

export type LeaderSchemaVersion = typeof LEADER_SCHEMA_VERSION;
export type LeaderOverrideSchemaVersion = typeof LEADER_OVERRIDE_SCHEMA_VERSION;

/**
 * Input shape accepted by write operations. Every field except `prompt`
 * is optional so callers can pass partial updates.
 */
export interface LeaderDocumentInput {
  schemaVersion?: LeaderSchemaVersion;
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  tools?: string[];
  plugins?: string[];
  skills?: string[];
  mcpServers?: string[];
  /** Markdown body following the YAML frontmatter. */
  prompt: string;
}

/**
 * Fully validated global Leader definition parsed from `$PILOT_HOME/leader.md`.
 */
export interface LeaderDefinition {
  schemaVersion: LeaderSchemaVersion;
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
  prompt: string;
}

export type LeaderToolProfile =
  | { mode: "inherit" }
  | { mode: "custom"; tools: string[] };

/**
 * Per-workspace override for the Leader. All fields are optional;
 * absent fields fall back to the global Leader definition.
 */
export interface LeaderWorkspaceOverride {
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  toolProfile?: LeaderToolProfile;
  prompt?: string;
  plugins?: string[];
  skills?: string[];
  mcpServers?: string[];
}

/**
 * On-disk schema for `$PILOT_HOME/teammates/leader-workspace-overrides.json`.
 */
export interface LeaderOverrideDocument {
  schemaVersion: LeaderOverrideSchemaVersion;
  workspaces: Record<string, LeaderWorkspaceOverride>;
}

/**
 * Resolved Leader config after merging global definition + workspace override.
 * Priority: workspace override > global leader.md > agent defaults.
 */
export interface ResolvedLeaderConfig {
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Extra tools appended to the 3 core team tools. */
  extraTools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
  /** User-defined prompt appended after the hardcoded Leader behavioural constraints. */
  prompt?: string;
}

export type LeaderDiagnosticSeverity = "error" | "warning";

export type LeaderDiagnosticCode =
  | "READ_FAILED"
  | "FRONTMATTER_MISSING"
  | "FRONTMATTER_UNTERMINATED"
  | "FRONTMATTER_INVALID"
  | "FRONTMATTER_NOT_OBJECT"
  | "SCHEMA_VERSION_REQUIRED"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "FIELD_TYPE_INVALID"
  | "UNKNOWN_FIELD"
  | "PROMPT_EMPTY"
  | "MODEL_NOT_FOUND"
  | "TOOL_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "MCP_SERVER_NOT_FOUND"
  | "OVERRIDE_INVALID_JSON"
  | "OVERRIDE_INVALID_SCHEMA";

export interface LeaderDiagnostic {
  code: LeaderDiagnosticCode;
  severity: LeaderDiagnosticSeverity;
  message: string;
  field?: string;
}

export interface LeaderValidationResult {
  ok: boolean;
  leader: LeaderDefinition | null;
  diagnostics: LeaderDiagnostic[];
}

export interface LeaderReadResult {
  leader: LeaderDefinition;
  content: string;
  filePath: string;
}

export interface LeaderManagerOptions {
  pilotHome: string;
}

export type LeaderOverrideStoreOptions = {
  pilotHome: string;
};

export type LeaderOverrideStoreErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "invalid_schema"
  | "revision_conflict"
  | "unsafe_path";

export type LeaderWorkspaceOverrideSnapshot = {
  canonicalWorkspace: string;
  override: LeaderWorkspaceOverride | undefined;
  revision: string;
};

export type LeaderGatewayReadInput = {
  projectKey?: string;
};

export type LeaderGatewayWriteInput = {
  document: LeaderDocumentInput;
};

export type LeaderWorkspaceOverrideGetInput = {
  projectKey: string;
};

export type LeaderWorkspaceOverrideSetInput = {
  projectKey: string;
  override: LeaderWorkspaceOverride;
  expectedRevision: string;
};

export type LeaderWorkspaceOverrideDeleteInput = {
  projectKey: string;
  expectedRevision: string;
};

export type LeaderWorkspaceOverrideResult = {
  canonicalProjectKey: string;
  override: LeaderWorkspaceOverride | undefined;
  revision: string;
  filePath: string;
};
