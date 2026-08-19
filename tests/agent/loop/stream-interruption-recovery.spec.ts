import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

test("agent loop drops interrupted tool calls and continues with a chunked-write prompt", async () => {
  const requests: CanonicalModelRequest[] = [];
  let scheduledToolCalls = 0;
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "call-1", name: "write_file" };
      yield { type: "tool_call_delta", id: "call-1", delta: '{"path":"deck.mjs","content":"partial"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: {
            phase: "tool_call",
            activeToolCalls: [{ id: "call-1", name: "write_file", argumentChars: 39 }],
          },
        },
      };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => { scheduledToolCalls += 1; });

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "stream-interruption",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a deck builder" }] }],
  })) {
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.equal(scheduledToolCalls, 0);
  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.ok(!events.some((event) => event.type === "turn_failed"));
  const recoveryRequest = requests[1]!;
  const recoveryText = recoveryRequest.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /small focused write_file or edit_file calls/);
  assert.doesNotMatch(JSON.stringify(recoveryRequest.messages), /\"content\":\"partial/);
});

test("agent loop recovers an unknown finish reason before treating the turn as successful", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "partial" };
      yield { type: "message_end", finishReason: "unknown" };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "unknown-finish",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write an answer" }] }],
  })) {
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.ok(!events.some((event) => event.type === "unknown_finish_reason"));
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /without a recognized finish reason/);
});

test("unknown finish with partial Hermes tool text uses the specialized recovery", async () => {
  const requests: CanonicalModelRequest[] = [];
  let scheduledToolCalls = 0;
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"deck.mjs"';
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: partialToolText };
      yield { type: "message_end", finishReason: "unknown" };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => { scheduledToolCalls += 1; });

  for await (const _event of loop.run({
    sessionId: "unknown-partial-tool",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a deck builder" }] }],
  })) {
    // Consume the complete recovery flow.
  }

  assert.equal(requests.length, 2);
  assert.equal(scheduledToolCalls, 0);
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /partial tool-call XML\/text/);
  assert.equal(requests[1]!.messages.some((message) => message.role === "assistant"), false);
});

test("stream interruption with partial Hermes tool text does not persist the fragment", async () => {
  const requests: CanonicalModelRequest[] = [];
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"';
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: partialToolText };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: { phase: "text" },
        },
      };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "interrupted-partial-tool",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    // Consume the complete recovery flow.
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.messages.some((message) => message.role === "assistant"), false);
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /partial tool-call XML\/text/);
});

test("stream interruption exhaustion persists the final safe text fragment", async () => {
  const durable: string[] = [];
  let attempt = 0;
  const loop = createLoop(async function* (_decision, request) {
    attempt++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "final-fragment-" + attempt };
    yield {
      type: "error",
      error: {
        provider: "test",
        protocol: "openai",
        code: "timeout",
        message: "Stream idle timeout",
        retryable: true,
        streamInterruption: { phase: "text" },
      },
    };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "interrupted-exhausted",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
    onDurableMessage: async (message) => {
      durable.push(message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    },
  })) {
    // Consume the complete recovery flow.
  }

  assert.ok(durable.some((text) => text.includes("final-fragment-3")));
});

test("unknown finish exhaustion persists the final safe text fragment", async () => {
  const durable: string[] = [];
  let attempt = 0;
  const loop = createLoop(async function* (_decision, request) {
    attempt++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "unknown-fragment-" + attempt };
    yield { type: "message_end", finishReason: "unknown" };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "unknown-exhausted",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
    onDurableMessage: async (message) => {
      durable.push(message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    },
  })) {
    // Consume the complete recovery flow.
  }

  assert.ok(durable.some((text) => text.includes("unknown-fragment-3")));
});

function createLoop(
  execute: AgentRouterRuntime["execute"],
  onSchedule: () => void,
): AgentLoop {
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute,
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
  };
  return new AgentLoop(config, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          onSchedule();
          return [];
        },
      },
    },
    context,
  });
}
