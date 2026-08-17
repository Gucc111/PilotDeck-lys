import test from "node:test";
import assert from "node:assert/strict";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const NOW = "2026-08-16T09:00:00.000Z";

function result(sessionId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId: "turn-1",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: NOW,
    completedAt: NOW,
  };
}

async function runWithResult(throws: boolean): Promise<InMemoryTranscriptWriter> {
  const sessionId = throws ? "error-session" : "success-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  await metadataStore.saveAiTitle("Pinned at transcript tail", "title-turn");

  const successfulResult = result(sessionId);
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      if (throws) throw new Error("model unavailable");
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: successfulResult };
      return { result: successfulResult, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: false },
  );

  for await (const _event of runner.run({
    sessionId,
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "Create a briefing" },
  })) {
    // Exhaust the turn so the final metadata snapshot is persisted.
  }
  return transcript;
}

test("TurnRunner appends session metadata after successful and failed accepted turns", async () => {
  for (const throws of [false, true]) {
    const transcript = await runWithResult(throws);
    const lastEntry = transcript.entries.at(-1);
    assert.equal(lastEntry?.type, "session_metadata");
    if (lastEntry?.type === "session_metadata") {
      assert.equal(lastEntry.metadata.aiTitle, "Pinned at transcript tail");
    }
  }
});

test("TurnRunner persists a bounded prompt when a hook blocks a first turn", async () => {
  const sessionId = "blocked-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  const lifecycle = {
    async dispatch() {
      return {
        effects: [{ type: "block", reason: "blocked by test" }],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    },
  } as unknown as LifecycleRuntime;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      assert.fail("blocked turns must not run the model loop");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    lifecycle,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: false },
  );

  const prompt = "p".repeat(2 * 1024 * 1024);
  for await (const _event of runner.run({
    sessionId,
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: prompt },
  })) {
    // Exhaust the blocked turn so its metadata reappend is persisted.
  }

  const lastEntry = transcript.entries.at(-1);
  assert.equal(lastEntry?.type, "session_metadata");
  if (lastEntry?.type === "session_metadata") {
    assert.equal(lastEntry.metadata.firstPrompt, prompt.slice(0, 1_200));
    assert.equal(lastEntry.metadata.lastPrompt, prompt.slice(0, 1_200));
  }
});
