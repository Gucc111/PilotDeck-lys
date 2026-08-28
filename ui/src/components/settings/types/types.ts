import type { Dispatch, SetStateAction } from 'react';
import type { ToolCallSelector } from '../../../../../src/permission/protocol/types';

// Settings was trimmed down from the original multi-tab layout. The
// 'permissions' tab was re-added because the chat surface emits
// "Open settings" links from tool-permission prompts and we need somewhere
// for those to land. The agents/git/api/tasks/notifications/plugins/router/
// about tabs and their MCP form modals stay removed — see git history if
// you ever need to recover the multi-provider surface.
export type SettingsMainTab = 'appearance' | 'permissions' | 'config' | 'mcp' | 'gateway' | 'teammates';

export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;

export type SettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type TeammateDefinition = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
};

export type TeammateRecord = TeammateDefinition & {
  relativePath?: string;
  filePath?: string;
};

export type TeammateDiagnostic = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  relativePath?: string;
  field?: string;
  id?: string;
  relatedPaths?: string[];
};

export type TeammateCatalog = {
  tools: string[];
  plugins: string[];
  skills: string[];
  mcpServers: string[];
  diagnostics: TeammateDiagnostic[];
};

export type TeammateToolProfile =
  | { mode: 'inherit' }
  | {
      mode: 'custom';
      tools: string[];
      constraints: {
        allow: ToolCallSelector[];
        deny: ToolCallSelector[];
      };
    };

export type TeamSetSummary = {
  id: string;
  name: string;
  description?: string;
  revision: string;
};

export type TeamSetTeammateConfig = {
  toolProfile: TeammateToolProfile;
  contextPolicy?: 'persistent' | 'fresh_per_delegation';
  modelOverride?: string;
  promptOverride?: string;
  maxContextTokensOverride?: number;
  maxOutputTokensOverride?: number;
};

export type TeamSetLeaderConfig =
  | { mode: 'inherit' }
  | { mode: 'override'; model?: string; prompt?: string; maxContextTokens?: number; maxOutputTokens?: number; tools?: string[]; plugins?: string[]; skills?: string[]; mcpServers?: string[] }
  | { mode: 'standalone'; model?: string; prompt?: string; maxContextTokens?: number; maxOutputTokens?: number; tools?: string[]; plugins?: string[]; skills?: string[]; mcpServers?: string[] };

export type TeamSetDefinition = {
  id: string;
  name: string;
  description?: string;
  leader: TeamSetLeaderConfig;
  teammates: Record<string, TeamSetTeammateConfig>;
};

export type TeamSetWorkspaceAssignment = {
  canonicalProjectKey: string;
  teamSetId: string | null;
  revision: string;
};

export type CodeEditorSettingsState = {
  theme: 'dark' | 'light';
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
