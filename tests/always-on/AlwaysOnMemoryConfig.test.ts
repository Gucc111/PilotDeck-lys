import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultAlwaysOnConfig,
  parseAlwaysOnConfig,
} from "../../src/always-on/config/parseAlwaysOnConfig.js";

describe("Always-On memory config", () => {
  it("is enabled by default with extraction and consolidation thresholds", () => {
    assert.deepEqual(defaultAlwaysOnConfig().memory, {
      enabled: true,
      extractionThreshold: 3,
      consolidationThreshold: 15,
    });
  });

  it("parses memory overrides", () => {
    const diagnostics: Parameters<typeof parseAlwaysOnConfig>[1] = [];
    const config = parseAlwaysOnConfig({
      memory: {
        enabled: false,
        extractionThreshold: 5,
        consolidationThreshold: 20,
      },
    }, diagnostics);
    assert.deepEqual(config?.memory, {
      enabled: false,
      extractionThreshold: 5,
      consolidationThreshold: 20,
    });
    assert.deepEqual(diagnostics, []);
  });
});
