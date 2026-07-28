import type { ToolCallSelector } from "../../permission/index.js";

export type CompiledTeammateToolConstraints = {
  allow: readonly ToolCallSelector[];
  deny: readonly ToolCallSelector[];
};

export type RuntimeTeammateDefinition = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools: string[];
  plugins?: string[];
  skills?: string[];
  mcpServers?: string[];
  sourcePath: string;
  constraints: CompiledTeammateToolConstraints;
  canonicalWorkspace: string;
  workspaceBindingRevision: string;
  workspaceBindingFingerprint: string;
  activeProjectRoot: string;
};

export type TeammateSessionBinding = {
  leaderSessionId: string;
  projectRoot: string;
  definition: RuntimeTeammateDefinition;
  systemPrompt: string;
  constraints: CompiledTeammateToolConstraints;
  canonicalWorkspace: string;
  workspaceBindingRevision: string;
  workspaceBindingFingerprint: string;
};

export function teammateSessionKey(leaderSessionId: string, teammateId: string): string {
  return `${leaderSessionId}::teammate::${teammateId}`;
}
