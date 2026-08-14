import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TokenBudgetManager, type TokenAccountingRuntime, type TokenBudgetSnapshot } from "../../src/context/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import { SnipEngine } from "../../src/context/compaction/SnipEngine.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/protocol/types.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentTranscriptEntry,
} from "../../src/session/transcript/TranscriptEntry.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const TOTAL_CONTEXT_TOKENS = 110_000;
const RESERVED_OUTPUT_TOKENS = 65_536;
const EFFECTIVE_INPUT_TOKENS = 44_464;
const TARGET_POST_TOKENS = 26_678;
const CREATED_AT = "2026-08-14T00:00:00.000Z";

test("mock e2e: 110k/65536 compacts, persists one snapshot, and replays it", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const routedRequests: CanonicalModelRequest[] = [];
  const persisted: Array<{
    boundary: AgentControlBoundaryTranscriptEntry["boundary"];
    messages: CanonicalMessage[];
  }> = [];
  const durableMessages: CanonicalMessage[] = [];
  const compactionEngine = new CompactionEngine({
    provider: "mock",
    model_: "mock-summary",
    maxOutputTokens: 512,
    tokenAccounting: mockCompactionAccounting(),
    uuid: () => "compact-e2e-1",
    model: {
      async *stream(request): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\ncheckpoint-e2e-1" };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
  });
  const context = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    snipEngine: new SnipEngine({ keepHeadTurns: 0, keepTailTurns: 2 }),
    maxContextTokens: TOTAL_CONTEXT_TOKENS,
  });
  const loop = createAgentLoop({
    context,
    tokenBudget,
    routedRequests,
    evaluateBudget: (request, options) => tokenBudget.snapshotFromTokens(
      hasSnipBoundary(request.messages) ? 26_000 : hasCompactSummary(request.messages) ? 36_000 : 42_000,
      options.maxContextTokens,
      { reservedOutputTokens: options.reservedOutputTokens },
    ),
  });
  const originalMessages = workBatch("legacy", true);
  const run = await drainAgentLoop(loop, {
    sessionId: "session-e2e",
    turnId: "turn-e2e",
    messages: originalMessages,
    onCompactPersisted: (snapshot) => {
      persisted.push(snapshot);
    },
    onDurableMessage: (message) => {
      durableMessages.push(message);
    },
  });

  assert.equal(summaryRequests.length, 1);
  assert.equal(routedRequests.length, 1);
  assert.equal(persisted.length, 1);
  assert.match(messagesText(summaryRequests[0]!.messages), /\[work:legacy-0\]/);
  assert.match(messagesText(routedRequests[0]!.messages), /checkpoint-e2e-1/);
  assert.equal(hasSnipBoundary(routedRequests[0]!.messages), true);
  assert.doesNotMatch(messagesText(routedRequests[0]!.messages), /\[work:legacy-0\]/);

  const boundary = compactBoundary(persisted[0]!.boundary);
  assert.equal(boundary.compactionId, "compact-e2e-1");
  assert.equal(boundary.targetTokens, TARGET_POST_TOKENS);
  assert.equal(boundary.postTokens, 26_000);
  assert.equal(boundary.summaryGenerated, true);
  assert.equal(boundary.checkpointMerged, false);
  assert.ok(Math.abs((boundary.finalRatio ?? 0) - (26_000 / EFFECTIVE_INPUT_TOKENS)) < 0.000_001);
  assert.ok(persisted[0]!.messages.every((message) =>
    message.metadata?.compactSnapshotId === "compact-e2e-1"
      && message.metadata.compactReplacement === true
  ));

  const transcript = buildReplayTranscript({
    originalMessages,
    boundary: persisted[0]!.boundary,
    replacementMessages: persisted[0]!.messages,
    durableMessages,
    result: run.result,
  });
  const replay = replayTranscriptEntries(transcript);
  const replayText = messagesText(replay.messages);
  assert.match(JSON.stringify(transcript), /\[work:legacy-0\]/);
  assert.doesNotMatch(replayText, /\[work:legacy-0\]/);
  assert.match(replayText, /checkpoint-e2e-1/);
  assert.match(replayText, /mock model completed/);
  assert.equal(compactBoundary(replay.lastCompactBoundary!.boundary).compactionId, "compact-e2e-1");
});

test("mock e2e: the fourth rolling compaction merges three stable checkpoints", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  let summarySequence = 0;
  const compactionEngine = new CompactionEngine({
    provider: "mock",
    model_: "mock-summary",
    maxOutputTokens: 512,
    tokenAccounting: mockCompactionAccounting(),
    model: {
      async *stream(request): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        summarySequence += 1;
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: `## Objective\ncheckpoint-${summarySequence}` };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    maxContextTokens: TOTAL_CONTEXT_TOKENS,
  });

  let messages = workBatch("cycle-1");
  const checkpointCounts: number[] = [];
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const expectedCheckpoint = `checkpoint-${cycle}`;
    const result = await runtime.tryAutoCompact({
      messages,
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
      budgetEvaluator: (candidate) => Promise.resolve(tokenBudget.snapshotFromTokens(
        messagesText(candidate).includes(expectedCheckpoint) ? 25_000 : 42_000,
        TOTAL_CONTEXT_TOKENS,
        { reservedOutputTokens: RESERVED_OUTPUT_TOKENS },
      )),
    });

    assert.equal(result.type, "compacted");
    assert.equal(result.result?.targetPostTokens, TARGET_POST_TOKENS);
    assert.equal(result.result?.checkpointMerged, cycle === 4);
    checkpointCounts.push(countCompactBoundaries(result.messages));
    messages = cycle < 4
      ? [...result.messages, ...workBatch(`cycle-${cycle + 1}`)]
      : result.messages;
  }

  assert.deepEqual(checkpointCounts, [1, 2, 3, 1]);
  assert.doesNotMatch(messagesText(summaryRequests[1]!.messages), /checkpoint-1/);
  assert.match(messagesText(summaryRequests[3]!.messages), /checkpoint-1/);
  assert.match(messagesText(summaryRequests[3]!.messages), /checkpoint-3/);
  assert.equal(countCompactBoundaries(messages), 1);
  assert.match(messagesText(messages), /checkpoint-4/);
});

test("mock e2e: zero-content compaction reaches the model without persisting a boundary", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const routedRequests: CanonicalModelRequest[] = [];
  const persisted: AgentControlBoundaryTranscriptEntry["boundary"][] = [];
  const compactionEngine = new CompactionEngine({
    provider: "mock",
    model_: "mock-summary",
    maxOutputTokens: 512,
    tokenAccounting: mockCompactionAccounting(),
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        summaryCalls += 1;
        yield { type: "text_delta", text: "unused" };
      },
    },
  });
  const context = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    maxContextTokens: TOTAL_CONTEXT_TOKENS,
  });
  const loop = createAgentLoop({
    context,
    tokenBudget,
    routedRequests,
    evaluateBudget: (request, options) => tokenBudget.snapshotFromTokens(
      hasCompactBoundary(request.messages) ? 20_000 : 42_000,
      options.maxContextTokens,
      { reservedOutputTokens: options.reservedOutputTokens },
    ),
  });
  await drainAgentLoop(loop, {
    sessionId: "session-noop-e2e",
    turnId: "turn-noop-e2e",
    messages: [{ role: "user", content: [{ type: "text", text: "Current request only" }] }],
    onCompactPersisted: ({ boundary }) => {
      persisted.push(boundary);
    },
  });

  assert.equal(summaryCalls, 0);
  assert.equal(persisted.length, 0);
  assert.equal(routedRequests.length, 1);
  assert.equal(hasCompactBoundary(routedRequests[0]!.messages), false);
  assert.match(messagesText(routedRequests[0]!.messages), /Current request only/);
});

function createAgentLoop(options: {
  context: DefaultContextRuntime;
  tokenBudget: TokenBudgetManager;
  routedRequests: CanonicalModelRequest[];
  evaluateBudget: (
    request: CanonicalModelRequest,
    options: { maxContextTokens: number; reservedOutputTokens?: number },
  ) => TokenBudgetSnapshot;
}): AgentLoop {
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
    execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
      options.routedRequests.push(request);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "mock model completed" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "unused" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "mock",
    model: "mock-agent",
    cwd: "/workspace/mock-project",
    maxContextTokens: TOTAL_CONTEXT_TOKENS,
    maxOutputTokens: RESERVED_OUTPUT_TOKENS,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/mock-project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { async executeAll() { return []; } },
    },
    context: options.context,
    tokenAccounting: {
      evaluateRequestBudget: async (request: CanonicalModelRequest, budgetOptions: {
        maxContextTokens: number;
        reservedOutputTokens?: number;
      }) => options.evaluateBudget(request, budgetOptions),
    } as unknown as TokenAccountingRuntime,
    getModelTokenLimits: () => ({
      maxContextTokens: TOTAL_CONTEXT_TOKENS,
      maxOutputTokens: RESERVED_OUTPUT_TOKENS,
    }),
  };
  return new AgentLoop(config, dependencies);
}

async function drainAgentLoop(loop: AgentLoop, input: AgentLoopInput) {
  const generator = loop.run(input);
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

function mockCompactionAccounting(): TokenAccountingRuntime {
  return {
    estimateMessages(messages: CanonicalMessage[]): number {
      return messages.reduce((total, message) => {
        const text = messagesText([message]);
        if (text.includes("[work:")) return total + 4_000;
        if (text.startsWith("[CONTEXT COMPACTION - REFERENCE ONLY]")) return total + 600;
        if (text.startsWith("<compact-boundary")) return total + 40;
        return total + 20;
      }, 0);
    },
  } as unknown as TokenAccountingRuntime;
}

function workBatch(label: string, inflateForTokenizer = false): CanonicalMessage[] {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{
      type: "text" as const,
      text: `[work:${label}-${index}]${inflateForTokenizer ? ` ${"context ".repeat(3_000)}` : ""}`,
    }],
  }));
}

function messagesText(messages: CanonicalMessage[]): string {
  return messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function hasCompactSummary(messages: CanonicalMessage[]): boolean {
  return messagesText(messages).includes("[CONTEXT COMPACTION - REFERENCE ONLY]");
}

function hasCompactBoundary(messages: CanonicalMessage[]): boolean {
  return messages.some((message) => message.content.some((block) =>
    block.type === "text" && block.text.startsWith("<compact-boundary")
  ));
}

function hasSnipBoundary(messages: CanonicalMessage[]): boolean {
  return messages.some((message) => message.content.some((block) =>
    block.type === "text" && block.text.startsWith("<snip-boundary")
  ));
}

function countCompactBoundaries(messages: CanonicalMessage[]): number {
  return messages.filter((message) => message.content.some((block) =>
    block.type === "text" && block.text.startsWith("<compact-boundary")
  )).length;
}

function compactBoundary(boundary: AgentControlBoundaryTranscriptEntry["boundary"]) {
  assert.equal(boundary.kind, "compact");
  assert.equal(boundary.subtype, "compact_boundary");
  return boundary.compactMetadata;
}

function buildReplayTranscript(input: {
  originalMessages: CanonicalMessage[];
  boundary: AgentControlBoundaryTranscriptEntry["boundary"];
  replacementMessages: CanonicalMessage[];
  durableMessages: CanonicalMessage[];
  result: Awaited<ReturnType<typeof drainAgentLoop>>["result"];
}): AgentTranscriptEntry[] {
  let sequence = 0;
  const base = () => ({
    sessionId: "session-e2e",
    turnId: "turn-e2e",
    sequence: ++sequence,
    createdAt: CREATED_AT,
  });
  return [
    {
      type: "accepted_input",
      ...base(),
      messages: input.originalMessages,
    },
    {
      type: "control_boundary",
      ...base(),
      boundary: input.boundary,
    },
    ...input.replacementMessages.map((message): AgentTranscriptEntry => ({
      type: "durable_message",
      ...base(),
      message,
    })),
    ...input.durableMessages.map((message): AgentTranscriptEntry => ({
      type: "durable_message",
      ...base(),
      message,
    })),
    {
      type: "turn_result",
      ...base(),
      result: input.result,
    },
  ];
}
