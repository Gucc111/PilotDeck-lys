import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PilotDeckMcpServerSpec } from "../protocol/types.js";

export const PILOTDECK_PROJECT_ROOT_MARKER = "__PILOTDECK_PROJECT_ROOT__";
export const PILOTDECK_NODE_EXECUTABLE_MARKER = "__PILOTDECK_NODE_EXECUTABLE__";
export const PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER = "__PILOTDECK_FUNASR_MCP_ENTRYPOINT__";
export const PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER = "__PILOTDECK_FUNASR_RUNTIME_ROOT__";

const MODULE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

function funasrEntrypoint(): string {
  // This relative path is identical in source and in dist, where built-in
  // plugin files are copied next to the compiled extension modules.
  return resolve(MODULE_DIR, "../../extension/plugins/builtin/funasr/funasr-local-mcp.mjs");
}

/** Resolve placeholders used only by the built-in project-scoped FunASR MCP. */
export function patchProjectScopedMcpSpec(
  spec: PilotDeckMcpServerSpec,
  projectRoot: string,
  pilotHome: string,
): PilotDeckMcpServerSpec {
  if (spec.id !== "funasr" || spec.transport !== "stdio") return spec;

  const replacements: Record<string, string> = {
    [PILOTDECK_PROJECT_ROOT_MARKER]: resolve(projectRoot),
    [PILOTDECK_NODE_EXECUTABLE_MARKER]: process.execPath,
    [PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER]: funasrEntrypoint(),
    [PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER]: join(resolve(pilotHome), "funasr"),
  };
  const replaceMarkers = (value: string) => Object.entries(replacements)
    .reduce((out, [marker, replacement]) => out.replaceAll(marker, replacement), value);

  return {
    ...spec,
    command: replaceMarkers(spec.command),
    cwd: resolve(projectRoot),
    args: spec.args?.map(replaceMarkers),
  };
}
