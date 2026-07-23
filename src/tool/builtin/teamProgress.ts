import type {
  PilotDeckTeamProgressSnapshot,
  PilotDeckTeamProgressUpdate,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";

export type TeamProgressInput = {
  items?: PilotDeckTeamProgressUpdate[];
  merge?: boolean;
  summary?: string | null;
};

export function createTeamProgressTool(): PilotDeckToolDefinition<
  TeamProgressInput,
  PilotDeckTeamProgressSnapshot
> {
  return {
    name: "team_progress",
    title: "Team Progress",
    description: [
      "Read or update the Team Leader's persistent structured progress file.",
      "Call without items or summary to read it.",
      "Use stable task ids and merge=true for incremental status updates.",
      "This tool cannot access arbitrary files.",
    ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
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
    isReadOnly: (input) => !input.items && input.summary === undefined,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "team_progress",
        message: "Writing the Team Leader's private progress file is allowed.",
      },
    }),
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<PilotDeckTeamProgressSnapshot>> => {
      if (context.runMode !== "team" || !context.team) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "team_progress is available only in Team mode.",
        );
      }
      const snapshot = input.items || input.summary !== undefined
        ? await context.team.updateProgress(input)
        : await context.team.readProgress();
      return {
        content: [{ type: "json", value: snapshot }],
        data: snapshot,
        metadata: { itemCount: snapshot.items.length },
      };
    },
  };
}
