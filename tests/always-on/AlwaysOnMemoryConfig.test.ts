import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultAlwaysOnConfig,
  parseAlwaysOnConfig,
} from "../../src/always-on/config/index.js";

describe("Always-On memory config", () => {
  it("has extraction and consolidation thresholds by default", () => {
    assert.deepEqual(defaultAlwaysOnConfig().memory, {
      extractionThreshold: 3,
      consolidationThreshold: 15,
    });
  });

  it("parses memory overrides", () => {
    const diagnostics: Parameters<typeof parseAlwaysOnConfig>[1] = [];
    const config = parseAlwaysOnConfig({
      memory: {
        extractionThreshold: 5,
        consolidationThreshold: 20,
      },
    }, diagnostics);
    assert.deepEqual(config?.memory, {
      extractionThreshold: 5,
      consolidationThreshold: 20,
    });
    assert.deepEqual(diagnostics, []);
  });

  it("emits warning for removed enabled field", () => {
    const diagnostics: Parameters<typeof parseAlwaysOnConfig>[1] = [];
    const config = parseAlwaysOnConfig({
      memory: {
        enabled: false,
        extractionThreshold: 3,
        consolidationThreshold: 15,
      },
    }, diagnostics);
    assert.deepEqual(config?.memory, {
      extractionThreshold: 3,
      consolidationThreshold: 15,
    });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "ALWAYS_ON_FIELD_REMOVED");
    assert.equal(diagnostics[0].severity, "warning");
    assert.equal(diagnostics[0].recoverable, true);
  });
});
