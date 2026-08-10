import type { PilotDeckToolDefinition } from "./protocol/types.js";

export const TEAM_MODE_CORE_TOOLS = new Set([
  "team_progress",
  "delegate_to_teammate",
  "send_team_message",
]);

/**
 * @deprecated Use `TEAM_MODE_CORE_TOOLS` + `buildTeamModeAllowedTools` instead.
 */
export const TEAM_MODE_ALLOWED_TOOLS = TEAM_MODE_CORE_TOOLS;

/**
 * Build the full set of allowed tools for Team mode by merging the
 * three immutable core tools with any user-configured extras from the
 * Leader definition.
 */
export function buildTeamModeAllowedTools(extraTools?: readonly string[]): Set<string> {
  const allowed = new Set(TEAM_MODE_CORE_TOOLS);
  if (extraTools) {
    for (const tool of extraTools) allowed.add(tool);
  }
  return allowed;
}

const TEAM_MODE_VIOLATION_HEADER = "[TEAM_MODE_VIOLATION]";

export function isTeamModeAllowedTool(
  tool: PilotDeckToolDefinition,
  allowedTools?: Set<string>,
): boolean {
  return (allowedTools ?? TEAM_MODE_CORE_TOOLS).has(tool.name);
}

export function buildTeamModeViolationMessage(toolName: string, hasExtraTools?: boolean): string {
  const guidance = hasExtraTools
    ? "The Team Leader may only use the configured tools, delegate tasks, and message Teammates."
    : "The Team Leader may only update team progress, delegate complete tasks, and message globally defined Teammates enabled for the current workspace.";
  return [
    `${TEAM_MODE_VIOLATION_HEADER} Tool "${toolName}" is BLOCKED in Team mode.`,
    "",
    guidance,
    "The Leader must not invoke tools outside its configured scope.",
    "",
    "Do NOT retry this tool. Delegate the work instead.",
  ].join("\n");
}

export function getTeamModeViolation(
  tool: PilotDeckToolDefinition,
  allowedTools?: Set<string>,
): string | undefined {
  return isTeamModeAllowedTool(tool, allowedTools)
    ? undefined
    : buildTeamModeViolationMessage(tool.name, allowedTools ? allowedTools.size > TEAM_MODE_CORE_TOOLS.size : false);
}

export function isTeamModeViolationText(text: unknown): boolean {
  return typeof text === "string" && text.includes(TEAM_MODE_VIOLATION_HEADER);
}
