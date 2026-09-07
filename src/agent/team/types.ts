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

const TEAMMATE_INFIX = process.platform === "win32" ? "--teammate--" : "::teammate::";
const DELEGATION_INFIX = process.platform === "win32" ? "--delegation--" : "::delegation::";

export function teammateSessionKey(leaderSessionId: string, teammateId: string): string {
  return `${leaderSessionId}${TEAMMATE_INFIX}${teammateId}`;
}

export function teammateSessionInstanceKey(
  leaderSessionId: string,
  teammateId: string,
  instanceId: string,
): string {
  return `${teammateSessionKey(leaderSessionId, teammateId)}${DELEGATION_INFIX}${instanceId}`;
}
