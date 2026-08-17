import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { SubAgentSession } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import {
  ToolRegistry,
  type PilotDeckSubagentForkApi,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

function createNoopTool(
  name: string,
  isReadOnly: PilotDeckToolDefinition["isReadOnly"],
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      data: {},
    }),
  };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

type TestableSubAgentSession = {
  buildConfig(): AgentRuntimeConfig;
};

type TestableAgentLoop = {
  buildSubagentForkApi(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): PilotDeckSubagentForkApi;
};

function parentConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode: "bypassPermissions",
      canPrompt: true,
      bypassAvailable: true,
    }),
  };
}

function sessionFor(config: AgentRuntimeConfig): TestableSubAgentSession {
  return new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect the provided files.",
    parentConfig: config,
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry: new ToolRegistry(),
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  }) as unknown as TestableSubAgentSession;
}

test("explore subagent ignores unrelated input-sensitive read-only tools", async () => {
  const readOnlyChecks: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createNoopTool("execute_code", (input) => {
    readOnlyChecks.push("execute_code");
    return (input as { code: string }).code.length === 0;
  }));
  registry.register(createNoopTool("read_file", () => {
    readOnlyChecks.push("read_file");
    return true;
  }));

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the provided files.",
    parentConfig: {
      provider: "test",
      model: "test-model",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: process.cwd(),
        mode: "bypassPermissions",
        canPrompt: true,
        bypassAvailable: true,
      }),
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown, FINAL_REPORT);
  assert.deepEqual(readOnlyChecks, ["read_file"]);
});

test("subagent config uses configured default model and caps", () => {
  const session = sessionFor({
    ...parentConfig(),
    provider: "main",
    model: "main-model",
    modelMultimodal: { input: ["text"] },
    maxContextTokens: 100000,
    maxOutputTokens: 20000,
    subagentModel: {
      provider: "child",
      model: "child-model",
      modelMultimodal: { input: ["text", "image"] },
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
    },
  });

  const config = session.buildConfig();

  assert.equal(config.provider, "child");
  assert.equal(config.model, "child-model");
  assert.deepEqual(config.modelMultimodal, { input: ["text", "image"] });
  assert.equal(config.maxContextTokens, 32000);
  assert.equal(config.maxOutputTokens, 4096);
});

test("subagent config inherits parent model when no default is configured", () => {
  const config = sessionFor(parentConfig()).buildConfig();

  assert.equal(config.provider, "test");
  assert.equal(config.model, "test-model");
});

test("configured subagent default remains a router baseline, not a router override", async () => {
  const seen: Array<{ stage: "decide" | "execute"; provider: string; model: string; isMainAgent?: boolean }> = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request, isMainAgent }) => {
      seen.push({
        stage: "decide",
        provider: request.provider,
        model: request.model,
        isMainAgent,
      });
      return {
        provider: "routed",
        model: "tier-model",
        scenarioType: "default",
        isSubagent: true,
        orchestrating: false,
        resolvedFrom: "tokenSaver",
        mutations: {},
      };
    },
    execute: async function* (_decision, request) {
      seen.push({
        stage: "execute",
        provider: request.provider,
        model: request.model,
      });
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    ...parentConfig(),
    provider: "main",
    model: "main-model",
    subagentModel: {
      provider: "child",
      model: "child-model",
    },
  }, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"],
    },
    eventEmitter: (event) => {
      events.push(event);
    },
  }) as unknown as TestableAgentLoop;
  const fork = loop.buildSubagentForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [],
  }, []);

  await fork.fork({
    definitionId: "explore",
    directive: "Inspect routing.",
    subagentId: "subagent-routed",
    timeoutMs: 60_000,
  });

  assert.deepEqual(seen, [
    {
      stage: "decide",
      provider: "child",
      model: "child-model",
      isMainAgent: false,
    },
    {
      stage: "execute",
      provider: "routed",
      model: "tier-model",
    },
  ]);
  assert.ok(events.some((event) => event.type === "subagent_completed"));
});
