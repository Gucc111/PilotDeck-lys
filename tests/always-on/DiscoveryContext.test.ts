import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractAllUserPrompts } from "../../src/always-on/phases/discovery/context/index.js";

function acceptedInput(text: string): string {
  return JSON.stringify({
    type: "accepted_input",
    messages: [{ content: [{ type: "text", text }] }],
  });
}

describe("Discovery context", () => {
  it("deduplicates prompts, truncates length, and skips malformed JSONL", () => {
    const prompts = extractAllUserPrompts(
      [
        "{ malformed",
        acceptedInput("  first prompt  "),
        acceptedInput("first prompt"),
        acceptedInput("this prompt is too long"),
      ].join("\n"),
      10,
      12,
    );

    assert.deepEqual(prompts, [
      "first prompt",
      "this prompt ...",
    ]);
  });

  it("honors max prompt count", () => {
    const prompts = extractAllUserPrompts(
      [
        acceptedInput("one"),
        acceptedInput("two"),
        acceptedInput("three"),
      ].join("\n"),
      2,
      20,
    );

    assert.deepEqual(prompts, ["one", "two"]);
  });
});
