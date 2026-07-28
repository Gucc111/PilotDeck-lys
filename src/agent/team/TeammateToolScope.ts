import { buildMcpToolWireName, parseMcpToolWireName } from "../../mcp/runtime/wireName.js";
import type { ToolRegistry } from "../../tool/registry/ToolRegistry.js";
import { TEAMMATE_INFRASTRUCTURE_TOOLS } from "../../tool/teammateCapabilityConstraints.js";
import type { RuntimeTeammateDefinition } from "./types.js";

const TEAMMATE_FORBIDDEN_TOOLS = new Set([
  "agent",
  "delegate_to_teammate",
  "team_progress",
  "ask_user_question",
]);

export function scopeTeammateTools(
  source: ToolRegistry,
  definition: RuntimeTeammateDefinition,
): ToolRegistry {
  const scoped = source.clone();
  const allowedTools = new Set(definition.tools ?? []);
  const allowedMcpServers = definition.mcpServers
    ? new Set(
        definition.mcpServers.map((serverId) => {
          const wire = buildMcpToolWireName(serverId, "tool");
          return parseMcpToolWireName(wire)?.serverId ?? serverId;
        }),
      )
    : undefined;

  for (const tool of scoped.list()) {
    if (TEAMMATE_INFRASTRUCTURE_TOOLS.has(tool.name)) {
      continue;
    }
    if (TEAMMATE_FORBIDDEN_TOOLS.has(tool.name)) {
      scoped.unregister(tool.name);
      continue;
    }

    const mcp = parseMcpToolWireName(tool.name);
    if (mcp) {
      const serverAllowed = !allowedMcpServers || allowedMcpServers.has(mcp.serverId);
      const toolAllowed = allowedTools.has(tool.name) || allowedTools.has("mcp");
      if (!serverAllowed || !toolAllowed) scoped.unregister(tool.name);
      continue;
    }

    if (!allowedTools.has(tool.name)) {
      scoped.unregister(tool.name);
    }
  }

  return scoped;
}
