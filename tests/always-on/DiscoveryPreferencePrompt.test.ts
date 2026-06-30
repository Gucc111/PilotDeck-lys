import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiscoveryPrompt } from "../../src/always-on/phases/discovery/prompts.js";

function prompt(language?: string): string {
  return buildDiscoveryPrompt({
    projectRoot: "/project",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    chatDir: "/chats",
    existingPlans: [
      { id: "pending", title: "Pending", summary: "pending summary", dedupeKey: "pending", status: "completed_no_report" },
      { id: "applied", title: "Applied", summary: "applied summary", dedupeKey: "applied", status: "applied" },
      { id: "archived", title: "Archived", summary: "archived summary", dedupeKey: "archived", status: "archived" },
    ],
    preferences: "## Preference marker",
    language,
  });
}

describe("Always-On discovery preference prompt", () => {
  it("injects preferences and groups completed_no_report, applied, and archived plans", () => {
    const content = prompt();
    assert.match(content, /substantively advance the user's core work objectives/);
    assert.match(content, /Always-On user preferences/);
    assert.match(content, /Preference marker/);
    assert.match(content, /\[completed_no_report\] "Pending"/);
    assert.match(content, /accepted and applied/);
    assert.match(content, /Plans rejected or abandoned/);
  });

  it("keeps Chinese prompt behavior aligned", () => {
    const content = prompt("zh-CN");
    assert.match(content, /实质性推进用户核心工作目标/);
    assert.match(content, /Always-On 用户偏好/);
    assert.match(content, /\[completed_no_report\] "Pending"/);
    assert.match(content, /用户已采纳并应用到原项目/);
    assert.match(content, /用户已抛弃的计划/);
  });
});
