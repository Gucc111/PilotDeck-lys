import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import {
  ReplaceLastTurnError,
  replaceLastWebSessionTurn,
} from "../../src/web/server/replaceLastTurn.js";

test("gateway waits for abort, rewrites, then evicts the cached session", async () => {
  const calls: string[] = [];
  const router = {
    abort: async () => { calls.push("abort"); },
    close: async () => { calls.push("close"); },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    replaceLastTurn: async (input) => {
      calls.push("rewrite");
      return {
        sessionKey: input.sessionKey,
        replacedTurnId: input.expectedTurnId,
        removedEntryCount: 3,
      };
    },
  });

  const result = await gateway.replaceLastTurn({
    sessionKey: "web:s_order",
    expectedTurnId: "turn-old",
  });

  assert.deepEqual(calls, ["abort", "rewrite", "close"]);
  assert.equal(result.removedEntryCount, 3);
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
      { sessionKey, projectKey: projectRoot, expectedTurnId: "turn-2" },
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
        { sessionKey, projectKey: projectRoot, expectedTurnId: "stale-turn" },
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
