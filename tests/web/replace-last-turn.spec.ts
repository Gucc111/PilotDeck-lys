import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import {
  finalizeLastWebSessionTurnReplacement,
  ReplaceLastTurnError,
  replaceLastWebSessionTurn,
} from "../../src/web/server/replaceLastTurn.js";

test("gateway waits for abort, rewrites, then evicts the cached session", async () => {
  const calls: string[] = [];
  const router = {
    abort: async () => { calls.push("abort"); },
    close: async () => { calls.push("close"); },
    activeTurnRunId: () => "turn-old",
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => {
      calls.push("rewrite");
      return {
        sessionKey: input.sessionKey,
        replacedTurnId: input.expectedTurnId,
        removedEntryCount: 3,
        transactionId: "11111111-1111-4111-8111-111111111111",
      };
    },
    finalizeLastTurnReplacement: async (input) => input,
  });

  const result = await gateway.replaceLastTurn({
    sessionKey: "web:s_order",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-new",
  });

  assert.deepEqual(calls, ["abort", "rewrite", "close"]);
  assert.equal(result.removedEntryCount, 3);
});

test("gateway rejects a stale replacement without aborting a newer active turn", async () => {
  const calls: string[] = [];
  const router = {
    abort: async () => { calls.push("abort"); },
    close: async () => { calls.push("close"); },
    activeTurnRunId: () => "turn-newer",
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async () => {
      calls.push("rewrite");
      throw new Error("must not rewrite");
    },
    finalizeLastTurnReplacement: async (input) => input,
  });

  await assert.rejects(
    gateway.replaceLastTurn({
      sessionKey: "web:s_stale_active",
      expectedTurnId: "turn-old",
      replacementTurnId: "turn-replacement",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "replace_turn_conflict"
    ),
  );
  assert.deepEqual(calls, []);
});

test("gateway commits the replacement transaction before emitting input_accepted", async () => {
  const calls: string[] = [];
  const fakeSession = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-replacement";
      yield { type: "turn_started", sessionId: "web:s_accept", turnId } as const;
      yield {
        type: "input_accepted",
        sessionId: "web:s_accept",
        turnId,
        messages: [{ role: "user", content: [{ type: "text", text: "corrected" }] }],
      } as const;
      yield {
        type: "turn_completed",
        sessionId: "web:s_accept",
        turnId,
        result: {
          type: "success",
          sessionId: "web:s_accept",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-08-25T10:00:00.000Z",
          completedAt: "2026-08-25T10:00:01.000Z",
        },
      } as const;
    },
    abort() {},
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession,
  });
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => ({
      sessionKey: input.sessionKey,
      replacedTurnId: input.expectedTurnId,
      removedEntryCount: 2,
      transactionId: "22222222-2222-4222-8222-222222222222",
    }),
    finalizeLastTurnReplacement: async (input) => {
      calls.push(input.action);
      return input;
    },
  });

  await gateway.replaceLastTurn({
    sessionKey: "web:s_accept",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-replacement",
  });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_accept",
    channelKey: "web",
    message: "corrected",
    runId: "turn-replacement",
  })) {
    events.push(event.type);
    if (event.type === "input_accepted") {
      assert.deepEqual(calls, ["commit"]);
    }
  }

  assert.ok(events.includes("input_accepted"));
  assert.deepEqual(calls, ["commit"]);
});

test("replaceLastWebSessionTurn removes only the latest turn and leaves workspace files untouched", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-turn-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-turn-home-"));
  try {
    const sessionKey = "web:s_replace_tail";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "first request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [{
      role: "user",
      content: [{ type: "text", text: "mistyped request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-2", {
      role: "assistant",
      content: [{ type: "text", text: "obsolete answer" }],
    });

    const workspaceFile = join(projectRoot, "already-changed.txt");
    await writeFile(workspaceFile, "keep current workspace state", "utf8");
    const result = await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-2",
        replacementTurnId: "turn-3",
      },
      { projectRoot, pilotHome },
    );

    const transcript = await readTranscript(storage.transcriptPath);
    assert.equal(result.replacedTurnId, "turn-2");
    assert.equal(result.removedEntryCount, 2);
    assert.deepEqual(new Set(transcript.entries.map((entry) => entry.turnId)), new Set(["turn-1"]));
    assert.equal(await readFile(workspaceFile, "utf8"), "keep current workspace state");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("replaceLastWebSessionTurn preserves session metadata written after the edited turn", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-metadata-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-metadata-home-"));
  try {
    const sessionKey = "web:s_replace_metadata";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "mistyped request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "obsolete answer" }],
    });
    await storage.transcript.recordSessionMetadata(sessionKey, "model-selection", {
      title: "Keep this title",
      firstPrompt: "mistyped request",
      lastPrompt: "mistyped request",
      modelSelection: { mode: "model", provider: "openai", model: "gpt-test" },
      updatedAt: "2026-08-25T10:00:00.000Z",
    });

    await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome, now: () => new Date("2026-08-25T11:00:00.000Z") },
    );

    const transcript = await readTranscript(storage.transcriptPath);
    const metadataEntry = transcript.entries.find((entry) => entry.type === "session_metadata");
    assert.ok(metadataEntry && metadataEntry.type === "session_metadata");
    assert.equal(metadataEntry.metadata.title, "Keep this title");
    assert.deepEqual(metadataEntry.metadata.modelSelection, {
      mode: "model",
      provider: "openai",
      model: "gpt-test",
    });
    assert.equal(metadataEntry.metadata.firstPrompt, undefined);
    assert.equal(metadataEntry.metadata.lastPrompt, undefined);
    assert.equal(metadataEntry.metadata.isSnapshot, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("failed replacement submission can restore the original transcript exactly", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-rollback-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-rollback-home-"));
  try {
    const sessionKey = "web:s_replace_rollback";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
      role: "user",
      content: [{ type: "text", text: "original request" }],
    }]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
    });
    const original = await readFile(storage.transcriptPath, "utf8");

    const replacement = await replaceLastWebSessionTurn(
      {
        sessionKey,
        projectKey: projectRoot,
        expectedTurnId: "turn-1",
        replacementTurnId: "turn-2",
      },
      { projectRoot, pilotHome },
    );
    await finalizeLastWebSessionTurnReplacement(
      {
        sessionKey,
        projectKey: projectRoot,
        transactionId: replacement.transactionId,
        action: "rollback",
      },
      { projectRoot, pilotHome },
    );

    assert.equal(await readFile(storage.transcriptPath, "utf8"), original);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("replaceLastWebSessionTurn rejects a stale target without changing the transcript", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-replace-conflict-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-replace-conflict-home-"));
  try {
    const sessionKey = "web:s_replace_conflict";
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    await storage.transcript.recordAcceptedInput(sessionKey, "current-turn", [{
      role: "user",
      content: [{ type: "text", text: "current request" }],
    }]);
    const before = await readFile(storage.transcriptPath, "utf8");

    await assert.rejects(
      replaceLastWebSessionTurn(
        {
          sessionKey,
          projectKey: projectRoot,
          expectedTurnId: "stale-turn",
          replacementTurnId: "replacement-turn",
        },
        { projectRoot, pilotHome },
      ),
      (error: unknown) => (
        error instanceof ReplaceLastTurnError && error.code === "replace_turn_conflict"
      ),
    );
    assert.equal(await readFile(storage.transcriptPath, "utf8"), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
