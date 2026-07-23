export const TEAMMATE_SCHEMA_VERSION = 1 as const;
export const TEAMMATE_ENABLEMENT_SCHEMA_VERSION = 1 as const;

export type TeammateSchemaVersion = typeof TEAMMATE_SCHEMA_VERSION;
export type TeammateEnablementSchemaVersion =
  typeof TEAMMATE_ENABLEMENT_SCHEMA_VERSION;

export interface TeammateDocumentInput {
  schemaVersion?: TeammateSchemaVersion;
  /** Explicit stable id. When omitted, `name` is used as the id. */
  id?: string;
  /** Display name, or the stable id for legacy/name-only definitions. */
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  plugins?: string[];
  skills?: string[];
  mcpServers?: string[];
  /** Markdown body following the YAML frontmatter. */
  prompt: string;
}

export interface TeammateDefinition {
  schemaVersion: TeammateSchemaVersion;
  id: string;
  name: string;
  description?: string;
  model?: string;
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
  prompt: string;
}

export interface TeammateRecord extends TeammateDefinition {
  /** POSIX path relative to `$PILOT_HOME/teammates`. */
  relativePath: string;
  filePath: string;
}

export interface TeammateEnablementDocument {
  schemaVersion: TeammateEnablementSchemaVersion;
  /** Canonical, absolute workspace paths mapped to complete enabled-ID sets. */
  workspaces: Record<string, string[]>;
}

export type TeammateEnablementStoreErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "invalid_schema"
  | "unsafe_path";

export interface TeammateEnablementStoreOptions {
  pilotHome: string;
}

export type TeammateDiagnosticSeverity = "error" | "warning";

export type TeammateDiagnosticCode =
  | "ROOT_NOT_DIRECTORY"
  | "UNSAFE_SYMLINK"
  | "READ_FAILED"
  | "FRONTMATTER_MISSING"
  | "FRONTMATTER_UNTERMINATED"
  | "FRONTMATTER_INVALID"
  | "FRONTMATTER_NOT_OBJECT"
  | "SCHEMA_VERSION_REQUIRED"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "FIELD_TYPE_INVALID"
  | "UNKNOWN_FIELD"
  | "ID_REQUIRED"
  | "ID_INVALID"
  | "PROMPT_REQUIRED"
  | "DUPLICATE_ID"
  | "TEAMMATE_NOT_FOUND"
  | "TEAMMATE_ENABLEMENT_INVALID"
  | "MODEL_NOT_FOUND"
  | "TOOL_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "MCP_SERVER_NOT_FOUND";

export interface TeammateDiagnostic {
  code: TeammateDiagnosticCode;
  severity: TeammateDiagnosticSeverity;
  message: string;
  relativePath?: string;
  field?: string;
  id?: string;
  relatedPaths?: string[];
}

export interface TeammateValidationResult {
  ok: boolean;
  teammate: TeammateDefinition | null;
  diagnostics: TeammateDiagnostic[];
}

export interface TeammateListResult {
  teammates: TeammateRecord[];
  diagnostics: TeammateDiagnostic[];
}

export interface TeammateReadResult {
  teammate: TeammateRecord;
  content: string;
}

export interface TeammateCreateInput {
  document: TeammateDocumentInput;
  /**
   * Optional nested POSIX path below `$PILOT_HOME/teammates`.
   * Defaults to `<resolved-id>.md`.
   */
  relativePath?: string;
}

export interface TeammateWriteInput {
  /** Existing stable id to update. */
  id: string;
  document: TeammateDocumentInput;
}

export interface TeammateDeleteResult {
  ok: true;
  id: string;
  relativePath: string;
}

export interface TeammateManagerOptions {
  pilotHome: string;
}

export type TeammatesListInput = Record<string, never>;

export type TeammateAddressInput = {
  id: string;
};

export type TeammateGatewayCreateInput = {
  document: TeammateDocumentInput;
  relativePath?: string;
};

export type TeammateGatewayWriteInput = {
  id: string;
  document: TeammateDocumentInput;
};

export type TeammateCatalog = {
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
  /** Diagnostics caused by enablement or capabilities in the selected workspace. */
  diagnostics: TeammateDiagnostic[];
};

export type TeammateCatalogInput = {
  projectKey: string;
};

export type TeammateEnablementGetInput = {
  projectKey: string;
};

export type TeammateEnablementSetInput = {
  projectKey: string;
  enabledTeammateIds: string[];
};

export type TeammateEnablementResult = {
  canonicalProjectKey: string;
  enabledTeammateIds: string[];
  /** Absolute global enablement document path, used by hosts for reloads. */
  filePath: string;
};
