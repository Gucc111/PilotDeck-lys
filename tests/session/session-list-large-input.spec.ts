import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { searchChatHistory } from "../../src/session/search/searchChatHistory.js";
import { listProjectSessions } from "../../src/session/storage/SessionList.js";

const NOW = "2026-08-16T09:00:00.000Z";

function entry(type: string, sessionId: string, sequence: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, sessionId, turnId: "turn-1", sequence, createdAt: NOW, ...extra };
}

test("lists historical sessions whose large inline image hides metadata from the lite preview", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const largeSessionId = "web:s_large-image";
    const largeTitle = "Recovered PilotDeck session title";
    const largeInput = entry("accepted_input", largeSessionId, 1, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Build the briefing" },
          { type: "image", source: "base64", data: "x".repeat(2 * 1024 * 1024) },
        ],
      }],
    });
    const largeMetadata = entry("session_metadata", largeSessionId, 2, {
      metadata: { aiTitle: largeTitle, firstPrompt: "p".repeat(130 * 1024) },
    });
    const modelSelectionPatch = entry("session_metadata", largeSessionId, 3, {
      metadata: { modelSelection: { mode: "auto" } },
    });
    const largeTail = entry("assistant_message", largeSessionId, 4, {
      message: { role: "assistant", content: [{ type: "text", text: `findable ${"y".repeat(160 * 1024)}` }] },
    });
    const latestInput = entry("accepted_input", largeSessionId, 5, {
      messages: [{ role: "user", content: [{ type: "text", text: "Latest prompt" }] }],
    });
    await writeFile(
      join(chatDir, `${largeSessionId}.jsonl`),
      `${JSON.stringify(largeInput)}\n${JSON.stringify(largeMetadata)}\n${JSON.stringify(modelSelectionPatch)}\n${JSON.stringify(largeTail)}\n${JSON.stringify(latestInput)}\n`,
    );

    const smallSessionId = "web:s_small";
    await writeFile(
      join(chatDir, `${smallSessionId}.jsonl`),
      `${JSON.stringify(entry("session_metadata", smallSessionId, 1, { metadata: { aiTitle: "Small session" } }))}\n`,
    );

    const invalidSessionId = "web:s_invalid";
    const invalidTail = entry("assistant_message", invalidSessionId, 3, {
      message: { role: "assistant", content: [{ type: "text", text: "z".repeat(160 * 1024) }] },
    });
    await writeFile(
      join(chatDir, `${invalidSessionId}.jsonl`),
      `${JSON.stringify(largeInput).replace(largeSessionId, invalidSessionId)}\n`
        + '{"type":"session_metadata","metadata":{"aiTitle":\n'
        + `${JSON.stringify(invalidTail)}\n`,
    );

    const sessions = await listProjectSessions({ projectRoot, pilotHome });
    assert.deepEqual(
      sessions.map((session) => [session.sessionId, session.summary]).sort((a, b) => a[0].localeCompare(b[0])),
      [
        [largeSessionId, largeTitle],
        [smallSessionId, "Small session"],
      ],
    );

    const search = await searchChatHistory({ projectRoot, pilotHome, query: "findable" });
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].sessionId, largeSessionId);
    assert.equal(search.matches[0].sessionTitle, largeTitle);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
