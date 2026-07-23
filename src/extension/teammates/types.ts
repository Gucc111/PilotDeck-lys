export const TEAMMATE_SCHEMA_VERSION = 1 as const;

export type TeammateSchemaVersion = typeof TEAMMATE_SCHEMA_VERSION;

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
  /** Path relative to `<projectRoot>/.pilotdeck/teammates`. */
  relativePath: string;
  filePath: string;
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
   * Optional nested path below the workspace teammate root.
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
  projectRoot: string;
}

export type TeammatesListInput = {
  projectKey: string;
};

export type TeammateAddressInput = {
  projectKey: string;
  id: string;
};

export type TeammateGatewayCreateInput = {
  projectKey: string;
  document: TeammateDocumentInput;
  relativePath?: string;
};

export type TeammateGatewayWriteInput = {
  projectKey: string;
  id: string;
  document: TeammateDocumentInput;
};

export type TeammateCatalog = {
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
};

export type TeammateCatalogInput = {
  projectKey: string;
};
