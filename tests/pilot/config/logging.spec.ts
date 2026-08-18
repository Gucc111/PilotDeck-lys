import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

const BASE_CONFIG = `schemaVersion: 1
agent:
  model: ollama/main-model
model:
  providers:
    ollama:
      models:
        main-model: {}
`;

async function withPilotHome(
  yaml: string,
  run: (pilotHome: string) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-logging-config-"));
  const pilotHome = join(root, "pilot-home");
  try {
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "pilotdeck.yaml"), yaml, "utf8");
    run(pilotHome);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("logging config defaults to pilot home logs directory", async () => {
  await withPilotHome(BASE_CONFIG, (pilotHome) => {
    const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
    assert.equal(snapshot.config.logging.enabled, true);
    assert.equal(snapshot.config.logging.level, "info");
    assert.equal(snapshot.config.logging.file.enabled, true);
    assert.equal(snapshot.config.logging.file.level, "debug");
    assert.equal(snapshot.config.logging.file.dir, join(pilotHome, "logs"));
  });
});

test("logging config accepts yaml and environment overrides", async () => {
  await withPilotHome(`${BASE_CONFIG}
logging:
  enabled: true
  level: debug
  networkDiagnostics: true
  file:
    enabled: true
    level: info
    dir: /tmp/from-yaml
    maxSizeMb: 7
    maxFiles: 3
`, (pilotHome) => {
    const snapshot = loadPilotConfig({
      env: {
        PILOT_HOME: pilotHome,
        PILOTDECK_LOG_LEVEL: "warn",
        PILOTDECK_LOG_DIR: "/tmp/from-env",
        PILOTDECK_LOG_FILE_ENABLED: "0",
        PILOTDECK_NETWORK_DIAGNOSTICS: "false",
      },
    });
    assert.equal(snapshot.config.logging.level, "warn");
    assert.equal(snapshot.config.logging.networkDiagnostics, false);
    assert.equal(snapshot.config.logging.file.enabled, false);
    assert.equal(snapshot.config.logging.file.level, "info");
    assert.equal(snapshot.config.logging.file.dir, "/tmp/from-env");
    assert.equal(snapshot.config.logging.file.maxSizeMb, 7);
    assert.equal(snapshot.config.logging.file.maxFiles, 3);
  });
});
