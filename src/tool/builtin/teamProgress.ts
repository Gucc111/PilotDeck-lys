import type {
  PilotDeckTeamProgressGetResult,
  PilotDeckTeamProgressListResult,
  PilotDeckTeamProgressUpdate,
  PilotDeckTeamProgressUpdateResult,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import {
  progressCounts,
  toProgressListItem,
  toProgressListResult,
} from "../../agent/team/TeamProgressStore.js";

export type TeamProgressInput = {
  action?: "list" | "get" | "update";
  taskId?: string;
  items?: PilotDeckTeamProgressUpdate[];
  merge?: boolean;
  summary?: string | null;
};

type TeamProgressOutput =
  | PilotDeckTeamProgressListResult
  | PilotDeckTeamProgressGetResult
  | PilotDeckTeamProgressUpdateResult;

export function createTeamProgressTool(): PilotDeckToolDefinition<
  TeamProgressInput,
  TeamProgressOutput
> {
  return {
    name: "team_progress",
    title: "Team Progress",
    description: [
      "Read or update the Team Leader's persistent structured progress file.",
      "Call without arguments or with action=list for a compact task list.",
      "Use action=get with taskId only when full task briefing is needed.",
      "Use action=update to update tasks; the result contains only changed task summaries.",
      "Use stable task ids and merge=true for incremental status updates.",
      "This tool cannot access arbitrary files.",
    ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "update"],
        },
        taskId: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              subject: { type: "string" },
              content: { type: "string" },
              briefing: { type: ["string", "null"] },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "failed", "cancelled"],
              },
              teammateId: { type: ["string", "null"] },
              blockedBy: { type: "array", items: { type: "string" } },
              summary: { type: ["string", "null"] },
            },
          },
        },
        merge: { type: "boolean", default: false },
        summary: { type: ["string", "null"] },
      },
    },
    isReadOnly: (input) =>
      input.action !== "update"
      && !input.items
      && input.summary === undefined,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "team_progress",
        message: "Writing the Team Leader's private progress file is allowed.",
      },
    }),
    execute: async (
      input,
      context,
    ): Promise<PilotDeckToolExecutionOutput<TeamProgressOutput>> => {
      if (context.runMode !== "team" || !context.team) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "team_progress is available only in Team mode.",
        );
      }
      const action = input.action
        ?? (input.items || input.summary !== undefined
          ? "update"
          : input.taskId
            ? "get"
            : "list");
      if (action === "get") {
        const taskId = input.taskId?.trim();
        if (!taskId) {
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            "team_progress action=get requires taskId.",
          );
        }
        const snapshot = await context.team.readProgress();
        const result: PilotDeckTeamProgressGetResult = {
          version: 2,
          task: snapshot.items.find((item) => item.id === taskId) ?? null,
          updatedAt: snapshot.updatedAt,
        };
        return {
          content: [{ type: "json", value: result }],
          data: result,
          metadata: { itemCount: result.task ? 1 : 0 },
        };
      }
      if (action === "list") {
        const result = toProgressListResult(await context.team.readProgress());
        return {
          content: [{ type: "json", value: result }],
          data: result,
          metadata: { itemCount: result.items.length },
        };
      }
      const snapshot = await context.team.updateProgress(input);
      const updatedIds = new Set((input.items ?? []).map((item) => item.id.trim()));
      const resolvedTaskIds = new Set(
        snapshot.items
          .filter((item) => item.status === "completed")
          .map((item) => item.id),
      );
      const result: PilotDeckTeamProgressUpdateResult = {
        version: 2,
        updated: snapshot.items
          .filter((item) => updatedIds.has(item.id))
          .map((item) => toProgressListItem(item, resolvedTaskIds)),
        counts: progressCounts(snapshot.items),
        updatedAt: snapshot.updatedAt,
      };
      return {
        content: [{ type: "json", value: result }],
        data: result,
        metadata: { itemCount: result.updated.length },
      };
    },
  };
}
