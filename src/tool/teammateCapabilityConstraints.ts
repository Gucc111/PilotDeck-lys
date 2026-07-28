import { matchToolCallSelector } from "../permission/index.js";
import type {
  PermissionContext,
  ToolCallSelector,
  ToolCallSelectorMatchResult,
} from "../permission/index.js";
import type { PilotDeckTeammateCapability } from "./protocol/types.js";

export const TEAMMATE_INFRASTRUCTURE_TOOLS = new Set([
  "send_team_message",
  "enter_plan_mode",
  "exit_plan_mode",
]);

export type TeammateScopeViolation = {
  behavior: "allow" | "deny";
  message: string;
  selector: ToolCallSelector;
  match: ToolCallSelectorMatchResult;
};

export function getTeammateScopeViolation(
  toolName: string,
  input: unknown,
  capability: PilotDeckTeammateCapability | undefined,
  permissionContext: PermissionContext,
): TeammateScopeViolation | undefined {
  if (!capability || TEAMMATE_INFRASTRUCTURE_TOOLS.has(toolName)) {
    return undefined;
  }

  const scopeContext: PermissionContext = {
    ...permissionContext,
    cwd: capability.activeProjectRoot,
  };
  for (const selector of capability.deny) {
    const match = matchToolCallSelector(
      selector,
      toolName,
      input,
      scopeContext,
      {
        commandAggregation: "any",
        commandExecutableMatch: "basename",
        commandParseFailureMatch: true,
        pathResolveFailureMatch: true,
      },
    );
    if (match.matched) {
      return {
        behavior: "deny",
        selector,
        match,
        message:
          `[TEAMMATE_SCOPE_VIOLATION] Teammate "${capability.teammateId}" is not allowed ` +
          `to call ${toolName} with these parameters because a deny capability selector matched.`,
      };
    }
  }

  const applicableAllowMatches = capability.allow
    .map((selector) => ({
      selector,
      match: matchToolCallSelector(
        selector,
        toolName,
        input,
        scopeContext,
        { commandAggregation: "all" },
      ),
    }))
    .filter(({ match }) => match.reason !== "tool_mismatch");
  if (
    applicableAllowMatches.length > 0 &&
    !applicableAllowMatches.some(({ match }) => match.matched)
  ) {
    const first = applicableAllowMatches[0]!;
    return {
      behavior: "allow",
      selector: first.selector,
      match: first.match,
      message:
        `[TEAMMATE_SCOPE_VIOLATION] Teammate "${capability.teammateId}" must match at least one ` +
        `allow capability selector for ${toolName}.`,
    };
  }

  return undefined;
}
