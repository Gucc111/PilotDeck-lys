import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/config/types.js";
import { createAgentProjectSessionStorage, readTranscript, replayTranscriptEntries } from "../../src/session/index.js";
import { activeTranscriptEntries } from "../../src/session/transcript/CompactSnapshot.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { createProjectId } from "../../src/pilot/index.js";
import { replaceLastWebSessionTurn, finalizeLastWebSessionTurnReplacement } from "../../src/web/server/replaceLastTurn.js";

async function fixture(t: test.TestContext, onRequest?: (request: CanonicalModelRequest) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-checkpoints-")), home = join(base, "home"), workspace = join(base, "workspace");
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, "skills"));
  const registration = join(home, "projects", createProjectId(workspace));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, ".cwd"), workspace);
  await writeFile(join(home, "pilotdeck.yaml"), `schemaVersion: 1
agent: { model: test/model, maxContextTokens: 32768, maxOutputTokens: 4096 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models: { model: {} }
`);
  const requests: CanonicalModelRequest[] = [];
  const options = {
    pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, "skills"),
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
      ...createModelRuntime(snapshot.config.model),
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        await onRequest?.(request);
        const text = request.messages.at(-1)?.content.filter(item => item.type === "text").map(item => item.type === "text" ? item.text : "").join("");
        if (text === "first" || text === "second") await writeFile(join(workspace, "demo.txt"), text);
        yield { type: "request_started", provider: request.provider, model: request.model };
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: `reply ${text}` };
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete() { return { role: "assistant" as const, content: [{ type: "text" as const, text: "Checkpoint QA" }], finishReason: "stop" as const }; },
    }),
  };
  let local = createLocalGateway(options);
  t.after(async () => { local.dispose(); await rm(base, { recursive: true, force: true }); });
  const sessionKey = "web:checkpoint-qa", input = { projectKey: workspace, sessionKey };
  return {
    home, workspace, sessionKey, requests, input,
    get gateway() { return local.gateway; },
    restart() { local.dispose(); local = createLocalGateway(options); },
    async submit(message: string) { for await (const _event of local.gateway.submitTurn({ ...input, channelKey: "web", message })) { /* consume */ } },
    async history() {
      const storage = createAgentProjectSessionStorage({ projectRoot: workspace, pilotHome: home, sessionId: sessionKey });
      return (await readTranscript(storage.transcriptPath)).entries;
    },
  };
}

// A saved restore boundary remains readable; no restore API is exercised.
async function legacyRestore(f: Awaited<ReturnType<typeof fixture>>, keepTurns: number) {
  const entries = await f.history();
  const inputs = entries.filter(entry => entry.type === "accepted_input");
  const cutoff = keepTurns < inputs.length ? inputs[keepTurns].sequence : Number.MAX_SAFE_INTEGER;
  const visible = entries.filter(entry => entry.sequence < cutoff);
  const storage = createAgentProjectSessionStorage({ projectRoot: f.workspace, pilotHome: f.home, sessionId: f.sessionKey });
  storage.transcript.restoreState(entries.at(-1)!.sequence, entries.at(-1)!.entryId!);
  await storage.transcript.recordControlBoundary(f.sessionKey, "legacy-restore", {
    kind: "restore", operationId: "old-operation", visibleSequences: visible.map(entry => entry.sequence),
    snapshot: { version: 1, messages: replayTranscriptEntries(visible).messages },
  });
}

test("removed checkpoint API rejects every action without touching user data", async t => {
  const f = await fixture(t);
  const directory = join(f.home, "checkpoints", "legacy"); await mkdir(directory, { recursive: true });
  const backup = join(directory, "existing-backup"); await writeFile(backup, "keep this backup");
  await writeFile(join(f.workspace, "manual.txt"), "keep this file");
  for (const action of ["list", "diff", "preview", "restore", "undo", "git"]) {
    await assert.rejects(f.gateway.manageCheckpoints!({ ...f.input, action }), { code: "CHECKPOINTS_REMOVED" });
  }
  assert.equal(await readFile(backup, "utf8"), "keep this backup");
  assert.equal(await readFile(join(f.workspace, "manual.txt"), "utf8"), "keep this file");
});

test("same-directory sessions reach the model concurrently and produce no checkpoints", async t => {
  let release!: () => void, bothStarted!: () => void, count = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { bothStarted = resolve; });
  const f = await fixture(t, async () => { if (++count === 2) bothStarted(); await held; });
  const consume = async (sessionKey: string) => { for await (const _event of f.gateway.submitTurn({ projectKey: f.workspace, sessionKey, channelKey: "web", message: "read only" })) {} };
  const first = consume("first"), second = consume("second");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Another Agent Loop blocked model entry")), 10_000); })]);
    // A Git operation does not wait for either held model request to end.
    assert.deepEqual(await f.gateway.repositoryOperation!({ projectKey: f.workspace, repositoryOperation: { operation: "init" } }).then(result => ({ success: (result as { success: boolean }).success })), { success: true });
  } finally { clearTimeout(timeout); release(); await Promise.all([first, second]); }
  assert.equal(count, 2);
  await assert.rejects(readdir(join(f.home, "checkpoints")), { code: "ENOENT" });
  assert.ok(!(await readdir(f.workspace, { recursive: true })).some(path => /file-history|checkpoint/.test(String(path))));
});

test("legacy restore boundaries preserve active UI pages and model context after restart", async t => {
  const f = await fixture(t); await f.submit("first"); await f.submit("second");
  await legacyRestore(f, 1);
  assert.equal(activeTranscriptEntries(await f.history()).filter(entry => entry.type === "accepted_input").length, 1);
  const whole = await readWebSessionMessages({ sessionKey: f.sessionKey }, { projectRoot: f.workspace, pilotHome: f.home });
  for (let offset = 0; offset < whole.messages.length; offset++) {
    const page = await readWebSessionMessages({ sessionKey: f.sessionKey, cursor: String(offset), limit: 1 }, { projectRoot: f.workspace, pilotHome: f.home });
    assert.ok(!JSON.stringify(page.messages).includes('"text":"second"'));
  }
  f.restart(); await f.submit("continue");
  const context = JSON.stringify(f.requests.at(-1)!.messages);
  assert.ok(context.includes('"text":"first"')); assert.ok(context.includes('"text":"continue"')); assert.ok(!context.includes('"text":"second"'));
});

test("editing the last visible turn after a legacy restore preserves archived history and transaction rollback", async t => {
  const f = await fixture(t); await f.submit("first"); await f.submit("second"); await legacyRestore(f, 1);
  const original = await f.history(), firstInput = activeTranscriptEntries(original).find(entry => entry.type === "accepted_input")!;
  const input = { ...f.input, expectedTurnId: firstInput.turnId, replacementTurnId: "replacement" };
  const options = { projectRoot: f.workspace, pilotHome: f.home };
  const replacement = await replaceLastWebSessionTurn(input, options);
  assert.equal((await f.history()).filter(entry => entry.type === "accepted_input").length, 2);
  assert.equal(activeTranscriptEntries(await f.history()).filter(entry => entry.type === "accepted_input").length, 0);
  await finalizeLastWebSessionTurnReplacement({ ...f.input, transactionId: replacement.transactionId, action: "rollback" }, options);
  assert.deepEqual(await f.history(), original);
  const committed = await replaceLastWebSessionTurn(input, options);
  await finalizeLastWebSessionTurnReplacement({ ...f.input, transactionId: committed.transactionId, action: "commit" }, options);
  f.restart(); await f.submit("corrected first");
  const context = JSON.stringify(f.requests.at(-1)!.messages);
  assert.ok(context.includes('"text":"corrected first"')); assert.ok(!context.includes('"text":"first"')); assert.ok(!context.includes('"text":"second"'));
});
