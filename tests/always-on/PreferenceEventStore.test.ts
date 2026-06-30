import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { PreferenceEventStore } from "../../src/always-on/infra/storage/log/PreferenceEventStore.js";
import type { PreferenceEvent } from "../../src/always-on/infra/storage/types.js";

function event(id: string): PreferenceEvent {
  return {
    schemaVersion: 2,
    eventId: id,
    timestamp: "2026-01-01T00:00:00.000Z",
    action: "apply",
    cycleId: "cycle-1",
    plans: [{
      id: `plan-${id}`,
      title: `Plan ${id}`,
      summary: "",
      dedupeKey: `plan-${id}`,
      outcome: "applied",
    }],
    indexed: false,
  };
}

describe("PreferenceEventStore", () => {
  it("appends, reads, and atomically marks v2 events indexed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-store-"));
    const filePath = join(root, "memory", "events.jsonl");
    try {
      const store = new PreferenceEventStore(filePath);
      await store.appendEvent(event("one"));
      assert.equal((await store.readUnindexedEvents()).length, 1);

      await store.markIndexed(["one"]);
      const [stored] = await store.readAll();
      assert.equal(stored?.indexed, true);
      assert.equal(stored?.schemaVersion, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes v1 events and skips malformed JSONL lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-legacy-"));
    const filePath = join(root, "events.jsonl");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(filePath, [
        "{bad-json",
        JSON.stringify({
          schemaVersion: 1,
          eventId: "legacy",
          timestamp: "2026-01-01T00:00:00.000Z",
          kind: "archived",
          cycleId: "cycle-1",
          plans: [{ id: "p1", title: "Legacy", summary: "old", dedupeKey: "p1" }],
          indexed: false,
        }),
        "",
      ].join("\n"), "utf-8");

      const [stored] = await new PreferenceEventStore(filePath).readAll();
      assert.equal(stored?.schemaVersion, 2);
      assert.equal(stored?.action, "archive");
      assert.equal(stored?.plans[0]?.outcome, "archived");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent append and index updates without losing events", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-concurrent-"));
    const filePath = join(root, "events.jsonl");
    try {
      const store = new PreferenceEventStore(filePath);
      await store.appendEvent(event("initial"));
      await Promise.all([
        store.markIndexed(["initial"]),
        ...Array.from({ length: 20 }, (_, index) => store.appendEvent(event(`event-${index}`))),
      ]);

      const stored = await store.readAll();
      assert.equal(stored.length, 21);
      assert.equal(stored.find((item) => item.eventId === "initial")?.indexed, true);
      assert.equal((await readFile(filePath, "utf-8")).trim().split("\n").length, 21);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
