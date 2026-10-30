import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelProtocol } from "../../../src/model/protocol/canonical.js";
import { ModelRequestDispatchError } from "../../../src/model/protocol/errors.js";
import { complete, streamModel, type ModelRequestDispatch } from "../../../src/model/streaming/streamModel.js";

const request: CanonicalModelRequest = {
  provider: "test", model: "controlled", messages: [
    { role: "user", content: [{ type: "text", text: "human request" }] },
    { role: "user", content: [{ type: "text", text: "deleted internal message" }], metadata: { teamEventIds: ["message-1"] } },
  ],
};
const config = (protocol: ModelProtocol) => parseModelConfig({ providers: { test: {
  protocol, url: "https://example.test/v1", apiKey: "key", retry: { streamMaxRetries: 0, requestMaxRetries: 0 }, models: { controlled: {} },
} } });
async function collect(events: AsyncIterable<CanonicalModelEvent>) { for await (const _event of events) { /* Drain the response. */ } }

for (const protocol of ["openai", "openai-responses", "anthropic"] as const) {
  test(`${protocol} dispatch filters the final transport body and starts transport before releasing the gate`, async () => {
    let started = false, body = "", dispatches = 0;
    const dispatchRequest: ModelRequestDispatch = async ({ request: pending, start }) => {
      dispatches += 1;
      assert.equal(started, false);
      const accepted = { ...pending, messages: pending.messages.filter(message => !message.metadata?.teamEventIds) };
      const value = start(accepted);
      assert.equal(started, true);
      return { request: accepted, value };
    };
    await collect(streamModel(request, config(protocol), { dispatchRequest, fetch: async (_url, init) => {
      started = true;
      body = String(init?.body);
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } }));
    assert.equal(dispatches, 1);
    assert.match(body, /human request/);
    assert.doesNotMatch(body, /deleted internal message/);
  });
}

for (const streaming of [false, true]) {
  test(`Google ${streaming ? "stream" : "complete"} filters at SDK invocation and preserves empty-batch cancellation`, async () => {
    let started = false, body = "";
    const googleClientFactory = () => ({ models: {
      generateContent: async (input: unknown) => { started = true; body = JSON.stringify(input); return { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] } as never; },
      generateContentStream: async (input: unknown) => {
        started = true; body = JSON.stringify(input);
        return (async function* () { yield { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] } as never; })();
      },
    } });
    const dispatchRequest: ModelRequestDispatch = async ({ request: pending, start }) => {
      const accepted = { ...pending, messages: pending.messages.slice(0, 1) };
      const value = start(accepted);
      assert.equal(started, true);
      return { request: accepted, value };
    };
    const options = { dispatchRequest, googleClientFactory };
    if (streaming) await collect(streamModel(request, config("google"), options));
    else await complete(request, config("google"), options);
    assert.match(body, /human request/);
    assert.doesNotMatch(body, /deleted internal message/);
    started = false;
    const cancelled = { ...options, dispatchRequest: async () => { throw new ModelRequestDispatchError("TEAM_EMPTY_BATCH", "Removed"); } };
    await assert.rejects(streaming ? collect(streamModel(request, config("google"), cancelled)) : complete(request, config("google"), cancelled), error => error instanceof ModelRequestDispatchError && error.code === "TEAM_EMPTY_BATCH");
    assert.equal(started, false);
  });
}

test("dispatch returns before the model response and retries use the filtered request body", async () => {
  let attempts = 0, gates = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const retryConfig = config("openai");
  retryConfig.providers.test!.retry = { streamMaxRetries: 1, baseDelayMs: 1 };
  const dispatchRequest: ModelRequestDispatch = async ({ request: pending, start }) => {
    gates += 1;
    const accepted = { ...pending, messages: pending.messages.slice(0, 1) };
    const value = start(accepted);
    assert.equal(attempts, gates);
    release();
    return { request: accepted, value };
  };
  await collect(streamModel(request, retryConfig, { dispatchRequest, fetch: async (_url, init) => {
    attempts += 1;
    assert.doesNotMatch(String(init?.body), /deleted internal message/);
    await waiting;
    return attempts === 1 ? new Response("temporary", { status: 503 }) : new Response("data: [DONE]\n\n");
  } }));
  assert.equal(attempts, 2);
  assert.equal(gates, 2);
});

test("endpoint and rejected stream-option fallbacks each cross the actual dispatch gate", async () => {
  const fallbackConfig = config("openai");
  fallbackConfig.providers.test!.url = "https://example.test";
  let attempts = 0, gates = 0;
  await collect(streamModel(request, fallbackConfig, {
    dispatchRequest: async ({ request: pending, start }) => {
      gates += 1;
      return { request: pending, value: start(pending) };
    },
    fetch: async (_url, init) => {
      attempts += 1;
      assert.equal(gates, attempts);
      if (attempts === 1) return new Response("missing", { status: 404 });
      if (attempts === 2) return new Response(JSON.stringify({ error: { message: "unsupported stream_options" } }), { status: 400 });
      assert.equal(JSON.parse(String(init?.body)).stream_options, undefined);
      return new Response("data: [DONE]\n\n");
    },
  }));
  assert.equal(attempts, 3);
  assert.equal(gates, 3);
});

test("provider extras cannot replace a Team batch whose consumption is being recorded", async () => {
  const extraConfig = config("openai");
  extraConfig.providers.test!.extraBody = { messages: [{ role: "user", content: "configuration override" }] };
  let body = "";
  await collect(streamModel(request, extraConfig, {
    dispatchRequest: async ({ request: pending, start }) => ({ request: pending, value: start(pending) }),
    fetch: async (_url, init) => { body = String(init?.body); return new Response("data: [DONE]\n\n"); },
  }));
  assert.match(body, /deleted internal message/);
  assert.doesNotMatch(body, /configuration override/);
});

test("a synchronous request preparation failure is explicitly marked as not dispatched", async () => {
  let transports = 0;
  await assert.rejects(collect(streamModel(request, config("openai"), {
    dispatchRequest: async ({ request: pending, start }) => {
      try { const value = start({ ...pending, model: "missing" }); return { request: pending, value }; }
      catch (error) { assert.equal((error as { requestDispatched?: boolean }).requestDispatched, false); throw new ModelRequestDispatchError("TEAM_EMPTY_BATCH", "preparation failed"); }
    },
    fetch: async () => { transports += 1; return new Response("data: [DONE]\n\n"); },
  })), error => error instanceof ModelRequestDispatchError);
  assert.equal(transports, 0);
});
