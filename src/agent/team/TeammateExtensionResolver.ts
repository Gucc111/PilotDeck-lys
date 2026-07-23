import {
  PluginRuntimeExtensionResolver,
  type ContributedCommand,
  type ContributedSkill,
  type ExtensionResolver,
  type McpServerInstruction,
} from "../../context/index.js";
import type { PluginRuntime } from "../../extension/index.js";
import type { RuntimeTeammateDefinition } from "./types.js";

export class TeammateExtensionResolver implements ExtensionResolver {
  private readonly base: PluginRuntimeExtensionResolver;

  constructor(
    runtime: PluginRuntime,
    private readonly definition: RuntimeTeammateDefinition,
  ) {
    this.base = new PluginRuntimeExtensionResolver(runtime);
  }

  listCommands(): ContributedCommand[] {
    const plugins = new Set(this.definition.plugins ?? []);
    if (plugins.size === 0) return [];
    return this.base.listCommands().filter((entry) => entry.namespace && plugins.has(entry.namespace));
  }

  listSkills(): ContributedSkill[] {
    const skills = new Set(this.definition.skills ?? []);
    const plugins = new Set(this.definition.plugins ?? []);
    if (skills.size === 0 && plugins.size === 0) return [];
    return this.base.listSkills().filter((entry) =>
      skills.has(entry.name) || Boolean(entry.namespace && plugins.has(entry.namespace)));
  }

  listMcpInstructions(): McpServerInstruction[] {
    const allowed = new Set(this.definition.mcpServers ?? []);
    if (allowed.size === 0) return [];
    return this.base.listMcpInstructions().filter((entry) => allowed.has(entry.serverName));
  }
}
