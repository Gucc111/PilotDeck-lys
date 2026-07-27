import test from "node:test";
import assert from "node:assert/strict";

import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";

test("transcript replay drops consumed transient lifecycle inputs but keeps reports", () => {
  const replay = replayTranscriptEntries([{
    type: "accepted_input",
    sessionId: "leader-1",
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Explicit teammate report" }],
        metadata: { synthetic: true, purpose: "team_message" },
      },
      {
        role: "user",
        content: [{ type: "text", text: "Teammate is idle" }],
        metadata: {
          synthetic: true,
          transient: true,
          transientId: "idle-1",
          purpose: "team_lifecycle",
        },
      },
    ],
  }]);

  assert.equal(replay.messages.length, 1);
  assert.equal(replay.messages[0]?.metadata?.purpose, "team_message");
  assert.equal(
    replay.events[0]?.type === "input_accepted"
      ? replay.events[0].messages.length
      : 0,
    1,
  );
});
