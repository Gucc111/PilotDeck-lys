export type RuntimeTeammateDefinition = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
  plugins?: string[];
  skills?: string[];
  mcpServers?: string[];
  sourcePath: string;
};

export type TeammateSessionBinding = {
  leaderSessionId: string;
  projectRoot: string;
  definition: RuntimeTeammateDefinition;
  systemPrompt: string;
};

export function teammateSessionKey(leaderSessionId: string, teammateId: string): string {
  return `${leaderSessionId}::teammate::${teammateId}`;
}
