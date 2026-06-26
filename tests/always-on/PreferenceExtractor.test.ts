import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  PreferenceExtractor,
  preparePreferenceMemory,
  readPreferences,
  type PreferenceLlmOptions,
} from "../../src/always-on/memory/PreferenceExtractor.js";
import { PreferenceEventStore } from "../../src/always-on/storage/log/PreferenceEventStore.js";
import type { PreferenceEvent } from "../../src/always-on/protocol/types.js";

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
      summary: `Summary ${id}`,
      dedupeKey: `plan-${id}`,
      outcome: id.includes("archive") ? "archived" : "applied",
    }],
    indexed: false,
  };
}

const OPENAI_LLM: PreferenceLlmOptions = {
  baseUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: " secret ",
  protocol: "openai",
};

describe("PreferenceExtractor", () => {
  it("calls OpenAI Chat Completions and indexes successful events", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-openai-"));
    try {
      const store = new PreferenceEventStore(join(root, "events.jsonl"));
      await store.appendEvent(event("one"));
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({
          choices: [{ message: { content: "## More likely to be accepted\n### Useful work\n- Plan one" } }],
        }), { status: 200 });
      }) as typeof fetch;

      const result = await new PreferenceExtractor(undefined, { fetch: fetchMock }).extract({
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: OPENAI_LLM,
        consolidationThreshold: 15,
      });

      assert.equal(result.extracted, true);
      assert.equal(requests[0]?.url, "https://example.test/v1/chat/completions");
      assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer secret");
      assert.equal((await store.readAll())[0]?.indexed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Anthropic Messages without duplicating /v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-anthropic-"));
    try {
      const store = new PreferenceEventStore(join(root, "events.jsonl"));
      await store.appendEvent(event("one"));
      let requestUrl = "";
      let requestHeaders: Record<string, string> = {};
      const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestUrl = String(input);
        requestHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          content: [{ type: "text", text: "## 更可能被用户接受\n### 高价值任务\n- Plan one" }],
        }), { status: 200 });
      }) as typeof fetch;

      await new PreferenceExtractor(undefined, { fetch: fetchMock }).extract({
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: { ...OPENAI_LLM, protocol: "anthropic" },
        consolidationThreshold: 15,
        language: "zh-CN",
      });

      assert.equal(requestUrl, "https://example.test/v1/messages");
      assert.equal(requestHeaders["x-api-key"], "secret");
      assert.equal(requestHeaders["anthropic-version"], "2023-06-01");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks NONE results indexed without replacing existing preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-none-"));
    try {
      const eventsFile = join(root, "events.jsonl");
      const preferencesFile = join(root, "preferences.md");
      const store = new PreferenceEventStore(eventsFile);
      await store.appendEvent(event("one"));
      await writeFile(preferencesFile, "existing preference", "utf-8");
      const fetchMock = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: "NONE" } }],
      }), { status: 200 })) as typeof fetch;

      await new PreferenceExtractor(undefined, { fetch: fetchMock }).extract({
        preferencesFile,
        eventStore: store,
        llm: OPENAI_LLM,
        consolidationThreshold: 15,
      });

      assert.equal(await readPreferences(preferencesFile), "existing preference");
      assert.equal((await store.readAll())[0]?.indexed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries retryable responses and consolidates excessive dimensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-retry-"));
    try {
      const store = new PreferenceEventStore(join(root, "events.jsonl"));
      await store.appendEvent(event("one"));
      let calls = 0;
      const sleeps: number[] = [];
      const fetchMock = (async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 429 });
        if (calls === 2) {
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: "## More likely to be accepted\n### A\nx\n### B\ny",
              },
            }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "## More likely to be accepted\n### Combined\nx" } }],
        }), { status: 200 });
      }) as typeof fetch;

      const result = await new PreferenceExtractor(undefined, {
        fetch: fetchMock,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }).extract({
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: OPENAI_LLM,
        consolidationThreshold: 1,
      });

      assert.equal(result.consolidated, true);
      assert.equal(calls, 3);
      assert.deepEqual(sleeps, [1000]);
      assert.match(await readFile(join(root, "preferences.md"), "utf-8"), /Combined/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps events unindexed after repeated network or timeout failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-failure-"));
    try {
      const store = new PreferenceEventStore(join(root, "events.jsonl"));
      await store.appendEvent(event("one"));
      let calls = 0;
      const fetchMock = (async (_input: URL | RequestInfo, init?: RequestInit) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }) as typeof fetch;

      const result = await new PreferenceExtractor(undefined, {
        fetch: fetchMock,
        sleep: async () => undefined,
      }).extract({
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: { ...OPENAI_LLM, timeoutMs: 1 },
        consolidationThreshold: 15,
      });

      assert.equal(result.extracted, false);
      assert.equal(calls, 3);
      assert.equal((await store.readAll())[0]?.indexed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("preparePreferenceMemory", () => {
  it("waits for the action threshold before extracting", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-threshold-"));
    try {
      const store = new PreferenceEventStore(join(root, "events.jsonl"));
      await store.appendEvent(event("one"));
      await store.appendEvent(event("two"));
      let calls = 0;
      const fetchMock = (async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "NONE" } }],
        }), { status: 200 });
      }) as typeof fetch;

      await preparePreferenceMemory({
        extractionThreshold: 3,
        consolidationThreshold: 15,
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: OPENAI_LLM,
        extractor: new PreferenceExtractor(undefined, { fetch: fetchMock }),
      });
      assert.equal(calls, 0);

      await store.appendEvent(event("three"));
      await preparePreferenceMemory({
        extractionThreshold: 3,
        consolidationThreshold: 15,
        preferencesFile: join(root, "preferences.md"),
        eventStore: store,
        llm: OPENAI_LLM,
        extractor: new PreferenceExtractor(undefined, { fetch: fetchMock }),
      });
      assert.equal(calls, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects existing preferences without an LLM", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-preference-existing-"));
    try {
      const preferencesFile = join(root, "preferences.md");
      await writeFile(preferencesFile, "## Existing", "utf-8");
      assert.equal(await preparePreferenceMemory({
        extractionThreshold: 3,
        consolidationThreshold: 15,
        preferencesFile,
      }), "## Existing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
