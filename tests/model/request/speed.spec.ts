import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest } from "../../../src/model/index.js";
import type {
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "../../../src/model/index.js";

test("all provider request builders pass speed only when configured", () => {
  for (const protocol of ["openai", "openai-responses", "anthropic"] as const) {
    const withSpeed = buildModelRequest(request(protocol, 0.65), modelConfig(protocol)) as Record<string, unknown>;
    assert.equal(withSpeed.speed, 0.65, `${protocol} should pass speed`);

    const withoutSpeed = buildModelRequest(request(protocol), modelConfig(protocol)) as Record<string, unknown>;
    assert.equal(withoutSpeed.speed, undefined, `${protocol} should omit unset speed`);
  }
  const googleBody = buildModelRequest(request("google", 0.65), modelConfig("google")) as Record<string, unknown>;
  assert.equal(googleBody.speed, undefined, "google should not advertise an unsupported top-level speed field");
});

test("provider request builders omit speed for models without the capability", () => {
  for (const protocol of ["openai", "openai-responses", "anthropic", "google"] as const) {
    const body = buildModelRequest(request(protocol, 0.65), modelConfig(protocol, false)) as Record<string, unknown>;
    assert.equal(body.speed, undefined, `${protocol} should filter unsupported speed`);
  }
});

function request(provider: ModelProtocol, speed?: number): CanonicalModelRequest {
  return {
    provider,
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true,
    ...(speed === undefined ? {} : { speed }),
  };
}

function modelConfig(protocol: ModelProtocol, supportsSpeed = true): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsSpeed,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const model: ModelDefinition = {
    id: "test-model",
    capabilities,
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: protocol,
    protocol,
    url: "https://example.invalid/v1",
    apiKey: "test-key",
    headers: {},
    models: { "test-model": model },
  };
  return { providers: { [protocol]: provider } };
}
