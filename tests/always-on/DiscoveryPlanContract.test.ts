import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanMarkdown } from "../../src/always-on/phases/discovery/contract/index.js";

function validPlan(overrides: Partial<Record<string, string>> = {}): string {
  const sections = {
    Summary: "Short summary.",
    Rationale: "This plan has a clear reason.",
    "Context Signals": "- User asked for Always-On cleanup.",
    "Proposed Change": "Move phase-owned contracts into the phase directory.",
    "Execution Steps": "1. Move files.\n2. Update imports.",
    Verification: "- Run focused tests.",
    ...overrides,
  };

  return [
    "# Phase Ownership Cleanup",
    "",
    "> Always-On Discovery Plan",
    "> id: plan_1",
    "> sourceRunId: run_1",
    "> createdAt: 2026-01-01T00:00:00.000Z",
    "> projectRoot: /project",
    "",
    "## Summary",
    sections.Summary,
    "",
    "## Rationale",
    sections.Rationale,
    "",
    "## Context Signals",
    sections["Context Signals"],
    "",
    "## Proposed Change",
    sections["Proposed Change"],
    "",
    "## Execution Steps",
    sections["Execution Steps"],
    "",
    "## Verification",
    sections.Verification,
  ].join("\n");
}

describe("Discovery plan contract", () => {
  it("parses required sections and metadata from a valid plan", () => {
    const parsed = parsePlanMarkdown(validPlan());

    assert.equal(parsed.title, "Phase Ownership Cleanup");
    assert.equal(parsed.metadata.id, "plan_1");
    assert.equal(parsed.metadata.sourceRunId, "run_1");
    assert.deepEqual(Object.keys(parsed.sections), [
      "Summary",
      "Rationale",
      "Context Signals",
      "Proposed Change",
      "Execution Steps",
      "Verification",
    ]);
  });

  it("rejects missing required sections", () => {
    const missingVerification = validPlan().replace(/\n\n## Verification\n- Run focused tests\.$/, "");

    assert.throws(
      () => parsePlanMarkdown(missingVerification),
      /plan must contain exactly the required sections/,
    );
  });

  it("rejects fuzzy TODO wording in Proposed Change", () => {
    assert.throws(
      () => parsePlanMarkdown(validPlan({ "Proposed Change": "TODO decide later." })),
      /plan Proposed Change must not be fuzzy/,
    );
  });
});
