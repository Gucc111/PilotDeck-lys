import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { resolveStreamIdleTimeout, streamModel } from "../../../src/model/streaming/streamModel.js";

function createConfig(input: { timeoutMs?: number; streamMaxRetries?: number; streamIdleTimeoutMs?: number } = {}) {
  return parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        timeoutMs: input.timeoutMs,
        retry: {
          streamMaxRetries: input.streamMaxRetries ?? 1,
          streamIdleTimeoutMs: input.streamIdleTimeoutMs,
          baseDelayMs: 1,
        },
        models: { "test-model": {} },
      },
    },
  });
}

function createRequest(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function sse(data: string): Response {
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("stream idle timeout defaults independently from provider request timeout", () => {
  const config = createConfig({ timeoutMs: 1 });
  const provider = config.providers.test!;

  assert.equal(resolveStreamIdleTimeout(provider), 600_000);
  assert.equal(resolveStreamIdleTimeout(provider, { streamTimeoutMs: 1234 }), 1234);
  assert.equal(resolveStreamIdleTimeout({ ...provider, retry: { streamIdleTimeoutMs: 5678 } }), 5678);
});

test("stream request setup uses the stream timeout instead of provider timeout", async () => {
  const config = createConfig({ timeoutMs: 1, streamMaxRetries: 0 });
  const events = await collect(streamModel(createRequest(), config, {
    streamTimeoutMs: 30,
    fetch: async (_input, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5);
        const signal = init?.signal as AbortSignal | null;
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(events.some((event) => event.type === "error"), false);
});

test("retries an interrupted stream only before the first content event", async () => {
  const config = createConfig();
  let requests = 0;
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async () => {
      requests++;
      return requests === 1 ? sse("") : sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(requests, 2);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("continues a pure text stream after interruption", async () => {
  const config = createConfig();
  const requestBodies: Array<Record<string, unknown>> = [];
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requestBodies.length === 1
        ? sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        : sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(requestBodies.length, 2);
  const messages = requestBodies[1]!.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.at(-2)?.role, "assistant");
  assert.equal(messages.at(-2)?.content, "partial");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("does not replay a stream after reasoning or tool-call output", async () => {
  const cases = [
    {
      name: "reasoning",
      payload: 'data: {"choices":[{"delta":{"reasoning_content":"think","content":"partial"}}]}\n\n',
      phase: "text",
    },
    {
      name: "tool call",
      payload: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"deck.mjs"}}]}}]}\n\n',
      phase: "tool_call",
    },
  ] as const;

  for (const item of cases) {
    const config = createConfig();
    let requests = 0;
    const events = await collect(streamModel(createRequest(), config, {
      fetch: async () => {
        requests++;
        return sse(item.payload);
      },
    }));

    const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
    assert.equal(requests, 1, item.name);
    assert.equal(error?.error.streamInterruption?.phase, item.phase, item.name);
  }
});
