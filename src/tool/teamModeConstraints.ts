import type { PilotDeckToolDefinition } from "./protocol/types.js";

export const TEAM_MODE_ALLOWED_TOOLS = new Set([
  "team_progress",
  "delegate_to_teammate",
]);

const TEAM_MODE_VIOLATION_HEADER = "[TEAM_MODE_VIOLATION]";

export function isTeamModeAllowedTool(tool: PilotDeckToolDefinition): boolean {
  return TEAM_MODE_ALLOWED_TOOLS.has(tool.name);
}

export function buildTeamModeViolationMessage(toolName: string): string {
  return [
    `${TEAM_MODE_VIOLATION_HEADER} Tool "${toolName}" is BLOCKED in Team mode.`,
    "",
    "The Team Leader may only update team progress and delegate complete tasks to globally defined Teammates enabled for the current workspace.",
    "The Leader must not inspect the workspace, run commands, edit files, or invoke ordinary subagents.",
    "",
    "Do NOT retry this tool. Delegate the work instead.",
  ].join("\n");
}

export function getTeamModeViolation(
  tool: PilotDeckToolDefinition,
): string | undefined {
  return isTeamModeAllowedTool(tool)
    ? undefined
    : buildTeamModeViolationMessage(tool.name);
}

export function isTeamModeViolationText(text: unknown): boolean {
  return typeof text === "string" && text.includes(TEAM_MODE_VIOLATION_HEADER);
}
