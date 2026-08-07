import type { ToolCallSelector } from "../../permission/index.js";
import type { TeammateContextPolicy } from "../../extension/teammates/types.js";

export type CompiledTeammateToolConstraints = {
  allow: readonly ToolCallSelector[];
  deny: readonly ToolCallSelector[];
};

export type RuntimeTeammateDefinition = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  contextPolicy?: TeammateContextPolicy;
  model?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
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
  sessionKey: string;
  systemPrompt: string;
  constraints: CompiledTeammateToolConstraints;
  contextPolicy?: TeammateContextPolicy;
  canonicalWorkspace: string;
  workspaceBindingRevision: string;
  workspaceBindingFingerprint: string;
};

export function teammateSessionKey(leaderSessionId: string, teammateId: string): string {
  return `${leaderSessionId}::teammate::${teammateId}`;
}

export function teammateSessionInstanceKey(
  leaderSessionId: string,
  teammateId: string,
  instanceId: string,
): string {
  return `${teammateSessionKey(leaderSessionId, teammateId)}::delegation::${instanceId}`;
}
