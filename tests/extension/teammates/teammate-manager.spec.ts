import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TeammateManager,
  TeammateManagerError,
  TeammateValidationError,
} from "../../../src/extension/teammates/index.js";

async function writeDefinition(
  projectRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(projectRoot, ".pilotdeck", "teammates", relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function definition(frontmatter: string, prompt = "You are a reliable teammate."): string {
  return `---\n${frontmatter.trim()}\n---\n\n${prompt}\n`;
}

test("TeammateManager scans recursively and remains isolated to one project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammates-isolation-"));
  try {
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await writeDefinition(
      projectA,
      "engineering/backend.md",
      definition(`
schemaVersion: 1
id: backend
name: Backend Engineer
description: Implements backend changes
model: claude-sonnet
tools: [read, edit]
plugins: [github]
skills: [typescript]
mcpServers: [linear]
`),
    );
    await writeDefinition(
      projectA,
      "legacy.md",
      definition(`
schemaVersion: 1
name: researcher
description: Finds relevant evidence
`),
    );
    await writeDefinition(
      projectB,
      "other.md",
      definition(`
schemaVersion: 1
id: other-project
name: Other Project
`),
    );
    // A global-looking definition deliberately sits outside either project.
    await writeDefinition(
      root,
      "global.md",
      definition(`
schemaVersion: 1
id: global
name: Global
`),
    );

    const managerA = new TeammateManager({ projectRoot: projectA });
    const managerB = new TeammateManager({ projectRoot: projectB });
    const listedA = await managerA.list();
    const listedB = await managerB.list();

    assert.deepEqual(listedA.teammates.map((item) => item.id), ["backend", "researcher"]);
    assert.deepEqual(listedA.diagnostics, []);
    assert.equal(listedA.teammates[0]?.relativePath, "engineering/backend.md");
    assert.deepEqual(listedA.teammates[0]?.tools, ["read", "edit"]);
    assert.deepEqual(listedA.teammates[0]?.mcpServers, ["linear"]);
    assert.equal(listedA.teammates[1]?.name, "researcher");
    assert.deepEqual(listedB.teammates.map((item) => item.id), ["other-project"]);
    assert.equal(await managerA.get("global"), null);
    assert.equal(await managerA.get("other-project"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateManager reports duplicate ids and structured validation diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammates-validation-"));
  try {
    await writeDefinition(
      root,
      "one.md",
      definition(`
schemaVersion: 1
id: duplicated
name: First
`),
    );
    await writeDefinition(
      root,
      "nested/two.md",
      definition(`
schemaVersion: 1
id: duplicated
name: Second
`),
    );
    await writeDefinition(
      root,
      "invalid.md",
      definition(
        `
schemaVersion: 2
id: ../escape
description: 42
tools: read
plugins: [github, 7]
unexpected: true
`,
        "",
      ),
    );

    const manager = new TeammateManager({ projectRoot: root });
    const listed = await manager.list();
    const duplicateDiagnostics = listed.diagnostics.filter(
      (item) => item.code === "DUPLICATE_ID",
    );
    assert.equal(duplicateDiagnostics.length, 2);
    assert.deepEqual(
      new Set(duplicateDiagnostics.map((item) => item.relativePath)),
      new Set(["one.md", "nested/two.md"]),
    );
    assert.equal(listed.diagnostics.some((item) => item.code === "ID_INVALID"), true);
    assert.equal(
      listed.diagnostics.some(
        (item) => item.code === "FIELD_TYPE_INVALID" && item.field === "description",
      ),
      true,
    );
    assert.equal(
      listed.diagnostics.some(
        (item) => item.code === "FIELD_TYPE_INVALID" && item.field === "tools",
      ),
      true,
    );
    assert.equal(listed.diagnostics.some((item) => item.code === "PROMPT_REQUIRED"), true);
    assert.equal(
      listed.diagnostics.some((item) => item.code === "SCHEMA_VERSION_UNSUPPORTED"),
      true,
    );
    assert.equal(listed.diagnostics.some((item) => item.code === "UNKNOWN_FIELD"), true);

    await assert.rejects(
      () => manager.get("duplicated"),
      (error: unknown) =>
        error instanceof TeammateManagerError && error.code === "duplicate_id",
    );

    const rawValidation = manager.validate(
      definition(
        `
schemaVersion: one
name: valid-id
skills: [testing, false]
`,
        "",
      ),
      "draft.md",
    );
    assert.equal(rawValidation.ok, false);
    assert.deepEqual(
      new Set(rawValidation.diagnostics.map((item) => item.code)),
      new Set(["FIELD_TYPE_INVALID", "PROMPT_REQUIRED"]),
    );
    assert.equal(
      rawValidation.diagnostics.every((item) => item.relativePath === "draft.md"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TeammateManager provides validated atomic CRUD and blocks path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-teammates-crud-"));
  try {
    const manager = new TeammateManager({ projectRoot: root });
    const created = await manager.create({
      relativePath: "product/planner.md",
      document: {
        id: "planner",
        name: "Product Planner",
        description: "Plans scoped product work",
        model: "gpt-5",
        tools: ["read"],
        plugins: [],
        skills: ["planning"],
        mcpServers: ["linear"],
        prompt: "Plan the requested work and identify risks.",
      },
    });
    assert.equal(created.teammate.relativePath, "product/planner.md");
    assert.match(created.content, /schemaVersion: 1/);
    assert.equal(
      await readFile(
        join(root, ".pilotdeck", "teammates", "product", "planner.md"),
        "utf8",
      ),
      created.content,
    );

    const fetched = await manager.get("planner");
    assert.equal(fetched?.name, "Product Planner");
    assert.equal((await manager.read("planner"))?.teammate.prompt, created.teammate.prompt);

    const written = await manager.write({
      id: "planner",
      document: {
        id: "planner",
        name: "Senior Product Planner",
        tools: ["read", "search"],
        prompt: "Create a concrete plan with acceptance criteria.",
      },
    });
    assert.equal(written.teammate.name, "Senior Product Planner");
    assert.deepEqual((await manager.get("planner"))?.tools, ["read", "search"]);
    assert.deepEqual(
      (await readdir(join(root, ".pilotdeck", "teammates", "product"))).filter((name) =>
        name.endsWith(".tmp"),
      ),
      [],
    );

    await assert.rejects(
      () =>
        manager.create({
          relativePath: "../escaped.md",
          document: { id: "escaped", prompt: "Do not escape." },
        }),
      (error: unknown) =>
        error instanceof TeammateManagerError && error.code === "unsafe_path",
    );
    await assert.rejects(
      () =>
        manager.create({
          document: { id: "no-prompt", prompt: "" },
        }),
      (error: unknown) =>
        error instanceof TeammateValidationError &&
        error.validation.diagnostics.some((item) => item.code === "PROMPT_REQUIRED"),
    );

    assert.deepEqual(await manager.delete("planner"), {
      ok: true,
      id: "planner",
      relativePath: "product/planner.md",
    });
    assert.equal(await manager.get("planner"), null);
    assert.equal((await manager.list()).teammates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
