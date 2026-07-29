import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckTeamSendMessageResult,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type SendTeamMessageInput = {
  to: string;
  message: string;
  summary?: string;
};

export function createSendTeamMessageTool(): PilotDeckToolDefinition<
  SendTeamMessageInput,
  PilotDeckTeamSendMessageResult
> {
  return {
    name: "send_team_message",
    title: "Send Team Message",
    description: [
      "Send a plain-text message without creating or updating a Team task.",
      "The Team Leader addresses an enabled teammate by stable teammate id.",
      'A Teammate may only address "leader".',
      "Messages are queued while the recipient is busy and delivered to that teammate's current Team session.",
      "Use delegate_to_teammate instead when assigning or advancing a bounded task.",
    ].join(" "),
    kind: "agent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "message"],
      properties: {
        to: {
          type: "string",
          description: 'Enabled teammate id, or "leader" when called by a Teammate.',
        },
        message: {
          type: "string",
          description: "The complete message to deliver.",
        },
        summary: {
          type: "string",
          description: "Optional short preview for status surfaces.",
        },
      },
    },
    maxResultBytes: 32_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async () => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "send_team_message",
        message: "Team messaging is allowed without a separate prompt.",
      },
    }),
    execute: async (
      input,
      context,
    ): Promise<PilotDeckToolExecutionOutput<PilotDeckTeamSendMessageResult>> => {
      if (!context.team) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "send_team_message is available only inside a Team Leader or Teammate session.",
        );
      }
      const to = input.to?.trim();
      const message = input.message?.trim();
      if (!to || !message) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "send_team_message requires non-empty to and message fields.",
        );
      }
      if (context.runMode !== "team" && to !== "leader") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          'Only a Team Leader may address a teammate; Teammates must use to="leader".',
        );
      }
      const result = await context.team.sendMessage({
        to,
        message,
        ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
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
      });
      return {
        content: [{
          type: "text",
          text: `Message ${result.messageId} queued for ${formatActor(result.to)}.`,
        }],
        data: result,
        metadata: {
          messageId: result.messageId,
          recipientRole: result.to.role,
          recipientId: result.to.id,
          status: result.status,
        },
      };
    },
  };
}

function formatActor(actor: PilotDeckTeamSendMessageResult["to"]): string {
  return actor.role === "leader" ? "the Team Leader" : `Teammate "${actor.id}"`;
}
