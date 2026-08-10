import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  LeaderManager,
  LeaderManagerError,
  LeaderValidationError,
  parseLeaderDocument,
  serializeLeaderDocument,
} from "../../../src/extension/leader/index.js";
import {
  getPilotLeaderDefinitionFilePath,
} from "../../../src/pilot/paths.js";

function definition(frontmatter: string, prompt = "You are a senior project manager."): string {
  return `---\n${frontmatter.trim()}\n---\n\n${prompt}\n`;
}

test("path helper resolves correctly", () => {
  const pilotHome = resolve("/tmp", "pilot-home");
  assert.equal(
    getPilotLeaderDefinitionFilePath(pilotHome),
    join(pilotHome, "leader.md"),
  );
});

test("parseLeaderDocument parses valid leader.md", () => {
  const content = definition(`
schemaVersion: 1
model: "openai/gpt-4.1"
maxContextTokens: 200000
maxOutputTokens: 16384
tools:
  - read_file
  - glob
plugins: []
skills:
  - project-analysis
mcpServers: []
`);
  const result = parseLeaderDocument(content);
  assert.ok(result.ok);
  assert.ok(result.leader);
  assert.equal(result.leader.model, "openai/gpt-4.1");
  assert.equal(result.leader.maxContextTokens, 200000);
  assert.equal(result.leader.maxOutputTokens, 16384);
  assert.deepEqual(result.leader.tools, ["read_file", "glob"]);
  assert.deepEqual(result.leader.plugins, []);
  assert.deepEqual(result.leader.skills, ["project-analysis"]);
  assert.deepEqual(result.leader.mcpServers, []);
  assert.equal(result.leader.prompt, "You are a senior project manager.");
});

test("parseLeaderDocument with empty body yields warning, not error", () => {
  const content = "---\nschemaVersion: 1\n---\n\n";
  const result = parseLeaderDocument(content);
  assert.ok(result.ok);
  assert.ok(result.leader);
  assert.equal(result.leader.prompt, "");
  assert.ok(result.diagnostics.some((d) => d.code === "PROMPT_EMPTY" && d.severity === "warning"));
});

test("parseLeaderDocument rejects missing frontmatter", () => {
  const result = parseLeaderDocument("Just some text");
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === "FRONTMATTER_MISSING"));
});

test("parseLeaderDocument rejects unknown schemaVersion", () => {
  const content = definition("schemaVersion: 99");
  const result = parseLeaderDocument(content);
  assert.ok(!result.ok);
  assert.ok(result.diagnostics.some((d) => d.code === "SCHEMA_VERSION_UNSUPPORTED"));
});

test("parseLeaderDocument reports unknown fields", () => {
  const content = definition("schemaVersion: 1\nunknownField: 42");
  const result = parseLeaderDocument(content);
  assert.ok(result.diagnostics.some((d) => d.code === "UNKNOWN_FIELD" && d.field === "unknownField"));
});

test("serializeLeaderDocument round-trips cleanly", () => {
  const input = {
    prompt: "Custom leader prompt",
    model: "anthropic/claude-sonnet-4",
    tools: ["bash", "read_file"],
    plugins: [],
    skills: [],
    mcpServers: [],
  };
  const serialized = serializeLeaderDocument(input);
  const parsed = parseLeaderDocument(serialized);
  assert.ok(parsed.ok);
  assert.ok(parsed.leader);
  assert.equal(parsed.leader.model, "anthropic/claude-sonnet-4");
  assert.deepEqual(parsed.leader.tools, ["bash", "read_file"]);
  assert.equal(parsed.leader.prompt, "Custom leader prompt");
});

test("LeaderManager.read returns null when file absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-absent-"));
  try {
    const manager = new LeaderManager({ pilotHome: root });
    const result = await manager.read();
    assert.equal(result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LeaderManager.read parses existing leader.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-read-"));
  try {
    const content = definition(`
schemaVersion: 1
model: openai/gpt-4.1
tools:
  - grep
`);
    await writeFile(join(root, "leader.md"), content, "utf8");
    const manager = new LeaderManager({ pilotHome: root });
    const result = await manager.read();
    assert.ok(result);
    assert.equal(result.leader.model, "openai/gpt-4.1");
    assert.deepEqual(result.leader.tools, ["grep"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LeaderManager.write creates and validates file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-write-"));
  try {
    const manager = new LeaderManager({ pilotHome: root });
    const result = await manager.write({
      prompt: "Lead the team effectively.",
      model: "openai/gpt-4.1",
      tools: ["read_file"],
      plugins: [],
      skills: [],
      mcpServers: [],
    });
    assert.ok(result.leader);
    assert.equal(result.leader.model, "openai/gpt-4.1");
    const onDisk = await readFile(join(root, "leader.md"), "utf8");
    assert.ok(onDisk.includes("openai/gpt-4.1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LeaderManager.write rejects invalid definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-leader-invalid-"));
  try {
    const manager = new LeaderManager({ pilotHome: root });
    await assert.rejects(
      () => manager.write({
        prompt: "Valid",
        schemaVersion: 99 as never,
      }),
      (error: unknown) => error instanceof LeaderValidationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LeaderManager constructor rejects empty pilotHome", () => {
  assert.throws(
    () => new LeaderManager({ pilotHome: "" }),
    (error: unknown) => error instanceof LeaderManagerError && error.code === "invalid_input",
  );
});
