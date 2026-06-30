import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackReport,
  parseReportMarkdown,
  type ReportMetadata,
} from "../../src/always-on/phases/report/contract/index.js";

const metadata: ReportMetadata = {
  runId: "run_1",
  planId: "plan_1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  outcome: "executed",
  workspaceStrategy: "git-worktree",
  workspaceHandle: "workspace_1",
};

describe("Report contract", () => {
  it("adds fallback sections when report content is incomplete", () => {
    const parsed = parseReportMarkdown(
      [
        "# Cleanup Work Report",
        "",
        "## Plan Reference",
        "plan_1",
      ].join("\n"),
      metadata,
    );

    assert.equal(parsed.title, "Cleanup Work Report");
    assert.equal(parsed.sections["Plan Reference"], "plan_1");
    assert.match(parsed.sections.Notes, /fallback: section-missing\(Steps Performed\)/);
    assert.ok(parsed.fallbacks.includes("section-missing(Verification Results)"));
  });

  it("downgrades required H1 headings into report sections", () => {
    const parsed = parseReportMarkdown(
      [
        "# Plan Reference",
        "plan_1",
        "",
        "# Steps Performed",
        "- Moved files.",
      ].join("\n"),
      metadata,
    );

    assert.equal(parsed.title, "Always-On Discovery Run");
    assert.equal(parsed.sections["Plan Reference"], "plan_1");
    assert.equal(parsed.sections["Steps Performed"], "- Moved files.");
    assert.ok(parsed.fallbacks.includes("h1-downgraded(Plan Reference)"));
    assert.ok(parsed.fallbacks.includes("h1-downgraded(Steps Performed)"));
  });

  it("builds fallback reports with required metadata and sections", () => {
    const report = buildFallbackReport({
      metadata,
      title: "Cleanup",
      reason: "missing-tool-call",
      partial: "raw payload",
    });

    assert.match(report, /^# Cleanup - Work Report/m);
    assert.match(report, /> Always-On Discovery Run Report/);
    assert.match(report, /> runId: run_1/);
    assert.match(report, /## Verification Results/);
    assert.match(report, /- fallback: missing-tool-call/);
    assert.match(report, /## Partial Tool Payload\nraw payload/);
  });
});
