import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function createNoopRouter(modelOverride?: string): AgentRouterRuntime {
  return {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: modelOverride ?? request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
}

function createContext(
  tokenBudget: TokenBudgetManager,
  tokens: number,
): AgentRuntimeDependencies["context"] {
  return {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({
      messages: input.messages,
      diagnostics: [],
    }),
    recoverFromModelError: async () => ({
      type: "give_up",
      reason: "test",
    }),
    captureTurn: async () => undefined,
    tryAutoCompact: async (input) => {
      await input.budgetEvaluator?.(input.messages);
      return {
        type: "skipped",
        snapshot: tokenBudget.snapshotFromTokens(tokens, 100, {
          reservedOutputTokens: input.reservedOutputTokens,
        }),
      };
    },
  };
}

function createConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    provider: "fixture",
    model: "model-a",
    cwd: "/workspace/project",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...overrides,
  };
}

async function drainLoop(loop: AgentLoop): Promise<void> {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ];
  for await (const _event of loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages,
  })) {
    // Drain the turn.
  }
}

test("agent loop respects agent maxContextTokens before and after routing", async () => {
  const tokenBudget = new TokenBudgetManager();
  const budgetEvaluations: Array<{ maxContextTokens?: number; reservedOutputTokens?: number }> = [];

  const dependencies: AgentRuntimeDependencies = {
    router: createNoopRouter("model-b"),
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    context: createContext(tokenBudget, 10_000),
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number; reservedOutputTokens?: number }) => {
        budgetEvaluations.push({
          maxContextTokens: options.maxContextTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        });
        return tokenBudget.snapshotFromTokens(10_000, options.maxContextTokens, {
          reservedOutputTokens: options.reservedOutputTokens,
        });
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    getModelTokenLimits(provider, model) {
      if (provider !== "fixture") return undefined;
      if (model === "model-a") {
        return { maxContextTokens: 200_000, maxOutputTokens: 128_000 };
      }
      if (model === "model-b") {
        return { maxContextTokens: 64_000, maxOutputTokens: 128_000 };
      }
      return undefined;
    },
  };

  const loop = new AgentLoop(createConfig({
    maxContextTokens: 128_000,
    maxOutputTokens: 65_536,
  }), dependencies);

  await drainLoop(loop);

  assert.equal(budgetEvaluations.length, 1);
  assert.equal(budgetEvaluations[0]!.maxContextTokens, 128_000);
  assert.equal(budgetEvaluations[0]!.reservedOutputTokens, 65_536);
});

test("agent loop does not reserve catalog max output for compaction unless requested", async () => {
  const tokenBudget = new TokenBudgetManager();
  const budgetEvaluations: Array<{ maxContextTokens?: number; reservedOutputTokens?: number }> = [];

  const dependencies: AgentRuntimeDependencies = {
    router: createNoopRouter(),
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    context: createContext(tokenBudget, 1_000),
    tokenAccounting: {
      evaluateRequestBudget: async (_request: unknown, options: { maxContextTokens: number; reservedOutputTokens?: number }) => {
        budgetEvaluations.push({
          maxContextTokens: options.maxContextTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        });
        return tokenBudget.snapshotFromTokens(1_000, options.maxContextTokens, {
          reservedOutputTokens: options.reservedOutputTokens,
        });
      },
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    getModelTokenLimits(provider, model) {
      if (provider === "fixture" && model === "model-a") {
        return { maxContextTokens: 200_000, maxOutputTokens: 128_000 };
      }
      return undefined;
    },
  };

  const loop = new AgentLoop(createConfig({ maxContextTokens: 128_000 }), dependencies);

  await drainLoop(loop);

  assert.equal(budgetEvaluations.length, 1);
  assert.equal(budgetEvaluations[0]!.maxContextTokens, 128_000);
  assert.equal(budgetEvaluations[0]!.reservedOutputTokens, 0);
});
