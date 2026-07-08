import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CronFire } from "../../src/cron/runtime/CronFire.js";
import type { GatewayEvent } from "../../src/gateway/index.js";
import type { CronTask } from "../../src/cron/index.js";

describe("CronFire turn events", () => {
  it("persists and forwards each gateway turn event in order", async () => {
    const events: GatewayEvent[] = [
      { type: "assistant_text_delta", text: "hello" },
      { type: "tool_call_started", toolCallId: "tool-1", name: "bash" },
      { type: "turn_completed", usage: {}, finishReason: "completed" },
    ];
    const persisted: GatewayEvent[] = [];
    const forwarded: Array<{ sessionKey: string; channelKey: string; event: GatewayEvent; metadata: unknown }> = [];

    const fire = new CronFire({
      gateway: {
        submitTurn: async function* () {
          yield* events;
        },
        abortTurn: async () => undefined,
      } as any,
      store: {
        putTask: async () => undefined,
        appendRunEvent: async (_runId: string, event: GatewayEvent) => {
          persisted.push(event);
        },
        appendRun: async () => undefined,
      } as any,
      now: () => new Date("2026-07-08T00:00:00.000Z"),
      registerActiveRun: () => undefined,
      unregisterActiveRun: () => undefined,
      getActiveRun: () => undefined,
      runTimeoutMs: 60_000,
      defaultTimezone: "UTC",
      releaseTaskSession: async () => undefined,
      onTurnEvent: (sessionKey, channelKey, event, metadata) => {
        forwarded.push({ sessionKey, channelKey, event, metadata });
      },
    });

    const task: CronTask = {
      schemaVersion: 1,
      taskId: "task-1",
      message: "run it",
      schedule: { type: "once", runAt: "2026-07-08T00:00:00.000Z" },
      status: "scheduled",
      sessionKey: "cron:task-1",
      channelKey: "cron",
      projectKey: "/tmp/project",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };

    await fire.runTask(task, "run-1");

    assert.deepEqual(persisted, events);
    assert.deepEqual(forwarded.map((item) => item.event), events);
    assert.equal(forwarded.every((item) => item.sessionKey === "cron:task-1"), true);
    assert.equal(forwarded.every((item) => item.channelKey === "cron"), true);
    assert.deepEqual(forwarded.map((item) => item.metadata), events.map(() => ({
      source: "cron",
      runId: "run-1",
      taskId: "task-1",
      projectKey: "/tmp/project",
    })));
  });
});
