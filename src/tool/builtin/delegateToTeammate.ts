import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckTeamDelegateResult,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type DelegateToTeammateInput = {
  teammateId: string;
  action?: "run" | "follow_up" | "shutdown";
  prompt?: string;
  taskId?: string;
};

export function createDelegateToTeammateTool(): PilotDeckToolDefinition<
  DelegateToTeammateInput,
  PilotDeckTeamDelegateResult
> {
  return {
    name: "delegate_to_teammate",
    title: "Delegate to Teammate",
    description: [
      "Dispatch a complete task or follow-up to a globally defined, long-lived Teammate enabled and valid for the current workspace.",
      "The teammate keeps its own context between calls.",
      "Use action=run for a new assignment, follow_up to refine previous work, and shutdown to stop the teammate.",
      "Different teammates may be dispatched in parallel; do not dispatch two concurrent turns to the same teammate.",
    ].join(" "),
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["teammateId"],
      additionalProperties: false,
      properties: {
        teammateId: {
          type: "string",
          description: "Stable id of a global Teammate enabled and valid for the current workspace.",
        },
        action: {
          type: "string",
          enum: ["run", "follow_up", "shutdown"],
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
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
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
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<PilotDeckTeamDelegateResult>> => {
      if (context.runMode !== "team" || !context.team) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "delegate_to_teammate is available only in Team mode.",
        );
      }
      const action = input.action ?? "run";
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
