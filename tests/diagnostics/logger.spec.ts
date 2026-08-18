import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDiagnosticLoggingEnv,
  createDiagnosticLogger,
  defaultDiagnosticLoggingConfig,
  serializeErrorForDiagnostics,
} from "../../src/diagnostics/logger.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-diagnostics-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("diagnostic logger writes JSONL using file level filtering", async () => {
  await withTempDir(async (dir) => {
    const logger = createDiagnosticLogger("gateway", {
      enabled: true,
      level: "error",
      networkDiagnostics: true,
      file: {
        enabled: true,
        level: "debug",
        dir,
        maxSizeMb: 20,
        maxFiles: 14,
      },
    });

    logger.debug({
      module: "model",
      event: "model_request_prepared",
      message: "prepared",
      metadata: { apiKey: "secret", bodyBytes: 123 },
    });

    const text = await readFile(join(dir, "gateway.jsonl"), "utf8");
    const line = JSON.parse(text.trim());
    assert.equal(line.level, "debug");
    assert.equal(line.module, "model");
    assert.equal(line.metadata.apiKey, "[redacted]");
    assert.equal(line.metadata.bodyBytes, 123);
  });
});

test("diagnostic logger defaults to PILOT_HOME logs directory and honors env overrides", () => {
  const config = defaultDiagnosticLoggingConfig({ PILOT_HOME: "/tmp/pilot-home" });
  assert.equal(config.file.dir, "/tmp/pilot-home/logs");

  const overridden = applyDiagnosticLoggingEnv(config, {
    PILOTDECK_LOG_LEVEL: "warn",
    PILOTDECK_LOG_DIR: "/tmp/custom-logs",
    PILOTDECK_LOG_FILE_ENABLED: "false",
    PILOTDECK_NETWORK_DIAGNOSTICS: "0",
  });
  assert.equal(overridden.level, "warn");
  assert.equal(overridden.file.dir, "/tmp/custom-logs");
  assert.equal(overridden.file.enabled, false);
  assert.equal(overridden.networkDiagnostics, false);
});

test("serializeErrorForDiagnostics preserves nested cause details", () => {
  const cause = Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  const error = new TypeError("fetch failed", { cause });

  const serialized = serializeErrorForDiagnostics(error) as Record<string, unknown>;
  assert.equal(serialized.name, "TypeError");
  assert.equal(serialized.message, "fetch failed");
  assert.deepEqual((serialized.cause as Record<string, unknown>).code, "ECONNRESET");
  assert.deepEqual((serialized.cause as Record<string, unknown>).syscall, "read");
});
