import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckTeamControlActionResult,
  PilotDeckTeamControlRequestKind,
  PilotDeckTeamControlRequestStatus,
  PilotDeckTeamDelegateResult,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type DelegateToTeammateAction =
  | "run"
  | "follow_up"
  | "shutdown"
  | "list_requests"
  | "read_request"
  | "allow_once"
  | "deny"
  | "request_revision"
  | "approve_plan"
  | "escalate_to_user";

export type DelegateToTeammateInput = {
  teammateId?: string;
  action?: DelegateToTeammateAction;
  prompt?: string;
  taskId?: string;
  requestId?: string;
  feedback?: string;
  status?: PilotDeckTeamControlRequestStatus;
  kind?: PilotDeckTeamControlRequestKind;
};

export function createDelegateToTeammateTool(): PilotDeckToolDefinition<
  DelegateToTeammateInput,
  PilotDeckTeamDelegateResult | PilotDeckTeamControlActionResult
> {
  return {
    name: "delegate_to_teammate",
    title: "Delegate to Teammate",
    description: [
      "Dispatch a complete task or follow-up to a globally defined Teammate enabled and valid for the current workspace.",
      "The teammate's workspace context policy controls whether it keeps one persistent session or starts a fresh session for each delegated task.",
      "run and follow_up dispatch in the background and return immediately.",
      "Use list_requests/read_request to inspect teammate permission or plan requests; resolve them with allow_once, deny, approve_plan, or request_revision.",
      "Use escalate_to_user when the Leader cannot safely decide; the host may surface it to the user.",
      "Different teammates may be dispatched in parallel; do not dispatch two concurrent turns to the same teammate.",
    ].join(" "),
    kind: "agent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        teammateId: {
          type: "string",
          description: "Stable id of a global Teammate enabled and valid for the current workspace.",
        },
        action: {
          type: "string",
          enum: [
            "run",
            "follow_up",
            "shutdown",
            "list_requests",
            "read_request",
            "allow_once",
            "deny",
            "request_revision",
            "approve_plan",
            "escalate_to_user",
          ],
          default: "run",
        },
        prompt: {
          type: "string",
          description: "Complete task briefing or follow-up feedback. Required unless action=shutdown.",
        },
        taskId: {
          type: "string",
          description: "Optional stable id from team_progress.",
        },
        requestId: {
          type: "string",
          description: "Control request id. Required for read/decision/escalation actions.",
        },
        feedback: {
          type: "string",
          description: "Optional denial reason, plan revision feedback, or escalation reason.",
        },
        status: {
          type: "string",
          enum: ["pending", "decided", "escalated", "resolved", "cancelled"],
          description: "Optional list_requests status filter.",
        },
        kind: {
          type: "string",
          enum: ["permission", "plan"],
          description: "Optional list_requests kind filter.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: (input) => input.action === "list_requests" || input.action === "read_request",
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async () => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "delegate_to_teammate",
        message: "Team delegation is allowed without a separate prompt.",
      },
    }),
    execute: async (
      input,
      context,
    ): Promise<PilotDeckToolExecutionOutput<PilotDeckTeamDelegateResult | PilotDeckTeamControlActionResult>> => {
      if (context.runMode !== "team" || !context.team) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "delegate_to_teammate is available only in Team mode.",
        );
      }
      const action = input.action ?? "run";
      if (action === "list_requests") {
        const requests = await context.team.listControlRequests({
          status: input.status,
          kind: input.kind,
        });
        const result: PilotDeckTeamControlActionResult = { action, requests };
        return controlOutput(result);
      }
      if (action === "read_request") {
        const requestId = requireRequestId(input, action);
        const request = await context.team.readControlRequest(requestId);
        if (!request) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Unknown Team control request "${requestId}".`,
          );
        }
        return controlOutput({ action, request });
      }
      if (isControlDecisionAction(action)) {
        const request = await context.team.controlRequest({
          action,
          requestId: requireRequestId(input, action),
          feedback: input.feedback,
        });
        return controlOutput({ action, request });
      }
      if (!input.teammateId?.trim()) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `delegate_to_teammate requires teammateId when action=${action}.`,
        );
      }
      if (action !== "shutdown" && !input.prompt?.trim()) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `delegate_to_teammate requires prompt when action=${action}.`,
        );
      }
      const definitions = context.team.listDefinitions();
      if (!definitions.some((definition) => definition.id === input.teammateId)) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown Teammate "${input.teammateId}". Available: ${definitions.map((d) => d.id).join(", ") || "(none)"}.`,
        );
      }
      const result = await context.team.delegate({
        teammateId: input.teammateId,
        action,
        prompt: input.prompt,
        taskId: input.taskId,
        parentTurnId: context.turnId,
        toolCallId: context.currentToolCallId,
        permission: {
          permissionMode: context.permissionMode,
          basePermissionMode: context.basePermissionMode ?? context.permissionMode,
          canPrompt: context.permissionContext.canPrompt,
          rules: {
            allow: context.permissionContext.rules.allow.map((rule) => ({ ...rule })),
            deny: context.permissionContext.rules.deny.map((rule) => ({ ...rule })),
            ask: context.permissionContext.rules.ask.map((rule) => ({ ...rule })),
          },
        },
        abortSignal: context.abortSignal,
      });
      return {
        content: [{ type: "text", text: formatDelegateResult(result) }],
        data: result,
        metadata: {
          teammateId: result.teammateId,
          teammateSessionId: result.teammateSessionId,
          status: result.status,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

function isControlDecisionAction(
  action: DelegateToTeammateAction,
): action is "allow_once" | "deny" | "request_revision" | "approve_plan" | "escalate_to_user" {
  return action === "allow_once"
    || action === "deny"
    || action === "request_revision"
    || action === "approve_plan"
    || action === "escalate_to_user";
}

function requireRequestId(input: DelegateToTeammateInput, action: DelegateToTeammateAction): string {
  const requestId = input.requestId?.trim();
  if (requestId) return requestId;
  throw new PilotDeckToolRuntimeError(
    "invalid_tool_input",
    `delegate_to_teammate requires requestId when action=${action}.`,
  );
}

function controlOutput(
  result: PilotDeckTeamControlActionResult,
): PilotDeckToolExecutionOutput<PilotDeckTeamControlActionResult> {
  const requests = result.requests ?? (result.request ? [result.request] : []);
  const text = requests.length === 0
    ? `Team control action ${result.action}: no matching requests.`
    : result.action === "read_request" && result.request
    ? [
        `Team control request: ${result.request.id}`,
        JSON.stringify(result.request, null, 2),
      ].join("\n")
    : [
        `Team control action: ${result.action}`,
        ...requests.map((request) =>
          `${request.id}: ${request.kind} from ${request.teammateId} (${request.status})`),
      ].join("\n");
  return {
    content: [{ type: "text", text }],
    data: result,
    metadata: {
      action: result.action,
      requestCount: requests.length,
      requestId: result.request?.id,
      status: result.request?.status,
    },
  };
}

function formatDelegateResult(result: PilotDeckTeamDelegateResult): string {
  return [
    `Teammate: ${result.teammateId}`,
    `Action: ${result.action}`,
    `Status: ${result.status}`,
    result.taskId ? `Task: ${result.taskId}` : undefined,
    `Session: ${result.teammateSessionId}`,
    "",
    result.summary || "(No summary returned.)",
  ].filter((line): line is string => line !== undefined).join("\n");
}
