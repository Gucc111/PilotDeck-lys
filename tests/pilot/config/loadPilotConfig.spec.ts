import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";

function configYaml(subagents: string): string {
  return `schemaVersion: 1
agent:
  model: ollama/main-model
  subagents:
${subagents}
model:
  providers:
    ollama:
      models:
        main-model: {}
        child-model: {}
`;
}

async function withPilotHome(
  yaml: string,
  run: (pilotHome: string) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-load-config-"));
  const pilotHome = join(root, "pilot-home");
  try {
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "pilotdeck.yaml"), yaml, "utf8");
    run(pilotHome);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("agent.subagents.default inherit and blank keep subagents inheriting the main model", async () => {
  await withPilotHome(configYaml("    default: inherit\n"), (pilotHome) => {
    const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });

    assert.equal(snapshot.config.agent.subagents?.default, undefined);
    assert.equal(snapshot.config.agent.subagents?.timeoutMs, undefined);
  });

  await withPilotHome(configYaml("    default: ''\n"), (pilotHome) => {
    const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });

    assert.equal(snapshot.config.agent.subagents?.default, undefined);
  });
});

test("agent.subagents.default resolves to a provider/model selection and params is tolerated", async () => {
  await withPilotHome(configYaml(`    default: ollama/child-model
    params: {}
    timeoutMs: 1234
`), (pilotHome) => {
    const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });

    assert.deepEqual(snapshot.config.agent.subagents?.default, {
      id: "ollama/child-model",
      provider: "ollama",
      model: "child-model",
    });
    assert.equal(snapshot.config.agent.subagents?.timeoutMs, 1234);
    assert.equal(
      snapshot.diagnostics.some((diagnostic) =>
        diagnostic.code === "CONFIG_AGENT_UNKNOWN_FIELD" &&
        diagnostic.path === "agent.subagents.params"),
      false,
    );
  });
});

test("invalid agent.subagents.default reports the subagent default path", async () => {
  await withPilotHome(configYaml("    default: ollama/missing-model\n"), (pilotHome) => {
    assert.throws(
      () => loadPilotConfig({ env: { PILOT_HOME: pilotHome } }),
      (error: unknown) => {
        assert.ok(error instanceof PilotConfigError);
        assert.equal(error.diagnostics[0]?.path, "agent.subagents.default");
        return true;
      },
    );
  });
});
