import { randomUUID } from "node:crypto";
import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
import { parsePlanMarkdown, type PlanContractOptions } from "../phases/discovery/contract/index.js";
import { AlwaysOnError } from "../infra/errors.js";
import { stripPlanUidFromFilename } from "../infra/storage/AlwaysOnPaths.js";
import type { DiscoveryPlanRecord } from "../infra/storage/types.js";
import type { AlwaysOnRunContextRegistry, DiscoveryRunContext } from "../phases/shared/RunContextRegistry.js";

export type AlwaysOnDiscoveryPlanInput = {
  title: string;
  summary: string;
  rationale: string;
  content: string;
};

export type AlwaysOnDiscoveryPlanOutput = {
  ok: true;
  planId: string;
  planFilePath: string;
};

export type CreateAlwaysOnDiscoveryPlanToolOptions = {
  runContexts: AlwaysOnRunContextRegistry;
  contract?: PlanContractOptions;
  now?: () => Date;
  uuid?: () => string;
};

export const ALWAYS_ON_PLAN_TOOL_NAME = "always_on_discovery_plan";

export function createAlwaysOnDiscoveryPlanTool(
  options: CreateAlwaysOnDiscoveryPlanToolOptions,
): PilotDeckToolDefinition<AlwaysOnDiscoveryPlanInput, AlwaysOnDiscoveryPlanOutput> {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;

  return {
    name: ALWAYS_ON_PLAN_TOOL_NAME,
    aliases: ["AlwaysOnDiscoveryPlan"],
    description:
      "Save the single discovery plan for this Always-On fire. Returns plan_quota_exhausted if called more than once per fire. Plan content must follow the PilotDeck Always-On plan markdown contract.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["title", "summary", "rationale", "content"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        rationale: { type: "string" },
        content: { type: "string", description: "Full plan markdown body." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const ctx = options.runContexts.getDiscovery(context.sessionId);
      if (!ctx) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `${ALWAYS_ON_PLAN_TOOL_NAME} called outside of an Always-On discovery turn.`,
        );
      }

      ctx.planCallCount += 1;
      if (ctx.plan) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "plan_quota_exhausted: Always-On discovery permits at most one plan per fire.",
        );
      }

      let parsed;
      try {
        parsed = parsePlanMarkdown(input.content, options.contract);
      } catch (error) {
        if (error instanceof AlwaysOnError) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            `plan_invalid: ${error.message}`,
          );
        }
        throw error;
      }

      const planId = parsed.metadata.id || `plan_${uuid()}`;
      const title = input.title.trim() || parsed.title;
      const fileUid = uuid().slice(0, 8);
      const filePath = await ctx.planStore.writePlanMarkdown(title, fileUid, parsed.rawContent);
      const record: DiscoveryPlanRecord = {
        id: planId,
        title,
        createdAt: now().toISOString(),
        summary: input.summary.trim(),
        rationale: input.rationale.trim(),
        sourceRunId: parsed.metadata.sourceRunId || ctx.runId,
        planFilePath: filePath,
      };
      const stored = await ctx.planStore.upsert(record);
      ctx.plan = { record: stored, markdown: parsed.rawContent };

      const data: AlwaysOnDiscoveryPlanOutput = {
        ok: true,
        planId: stored.id,
        planFilePath: stripPlanUidFromFilename(stored.planFilePath),
      };
      return {
        content: [
          { type: "text", text: `Plan saved as ${stored.id}.` },
          { type: "json", value: data },
        ],
        data,
        metadata: { runId: ctx.runId },
      };
    },
  };
}
