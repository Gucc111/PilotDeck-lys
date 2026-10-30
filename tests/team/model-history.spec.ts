import assert from 'node:assert/strict';
import test from 'node:test';
import { teamModelHistory } from '../../src/team/modelHistory.js';
import type { AgentTranscriptEntry } from '../../src/session/transcript/TranscriptEntry.js';
import type { CanonicalMessage } from '../../src/model/index.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeAgentSession } from '../../src/session/resume/resumeAgentSession.js';
import { createAgentProjectSessionStorage } from '../../src/session/storage/ProjectSessionStorage.js';
import { readTranscript } from '../../src/session/transcript/TranscriptReader.js';
import { createDefaultPermissionContext } from '../../src/permission/index.js';
import { ToolRegistry } from '../../src/tool/index.js';
import type { AgentRouterRuntime } from '../../src/agent/runtime/AgentRuntimeDependencies.js';

const current = { activationId: 'team', stopVersion: 2 };
function input(sequence: number, text: string, metadata?: Record<string, unknown>): AgentTranscriptEntry {
  return { type: 'accepted_input', sessionId: 's', turnId: `turn-${sequence}`, sequence, createdAt: '', messages: [{ role: 'user', content: [{ type: 'text', text }] }], metadata };
}
function durable(sequence: number, text: string, consumed?: boolean): AgentTranscriptEntry {
  return { type: 'durable_message', sessionId: 's', turnId: `turn-${sequence}`, sequence, createdAt: '', message: { role: 'user', content: [{ type: 'text', text }], metadata: { purpose: 'team_runtime', teamEventIds: [`message-${sequence}`], teamConsumed: consumed } } };
}
function compact(sequence: number, text: string): AgentTranscriptEntry {
  const message: CanonicalMessage = { role: 'user', content: [{ type: 'text', text }] };
  return { type: 'control_boundary', sessionId: 's', turnId: `turn-${sequence}`, sequence, createdAt: '', boundary: { kind: 'compact', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 100 }, snapshot: { version: 1, messages: [message] } } };
}
const fresh = (sequence: number) => input(sequence, 'current human input', { teamCommunicationVersion: 3, teamActivationId: 'team', teamStopVersion: 2 });

test('unproven old Team message and its model-derived continuation are isolated from new epoch context', () => {
  const entries = [input(1, 'old'), durable(2, 'pending old message'), compact(3, 'summary including pending old message'), input(4, 'old continuation')];
  assert.deepEqual(teamModelHistory(entries, current), []);
  const resumed = [...entries, fresh(5), durable(6, 'consumed new message', true), compact(7, 'clean summary')];
  assert.deepEqual(teamModelHistory(resumed, current), resumed.slice(4));
});

test('legacy Team compact snapshots are not trusted even when older source messages are absent', () => {
  const entries = [input(1, 'old Team prompt', { teamActivationId: 'team', teamStopVersion: 0 }), compact(2, 'unknown legacy summary'), fresh(3)];
  assert.deepEqual(teamModelHistory(entries, current), entries.slice(2));
});

test('legacy accepted input is unknown delivery even when its canonical message lost Team metadata', () => {
  const entries = [input(1, 'legacy member prompt', { teamActivationId: 'team', teamStopVersion: 0 }), input(2, 'derived assistant continuation'), fresh(3)];
  assert.deepEqual(teamModelHistory(entries, current), entries.slice(2));
});

test('new wakeup placeholders do not discard current consumed Team context', () => {
  const wakeup = input(1, 'Team messages are waiting.', { purpose: 'team_runtime_wakeup', teamCommunicationVersion: 3, teamActivationId: 'team', teamStopVersion: 2 });
  if (wakeup.type === 'accepted_input') wakeup.messages[0]!.metadata = { purpose: 'team_runtime', synthetic: true };
  const entries = [wakeup, durable(2, 'sent to model', true), compact(3, 'new clean summary')];
  assert.equal(teamModelHistory(entries, current), entries);
});

test('ordinary conversation and already proven Team messages keep their full model history', () => {
  const entries = [input(1, 'normal user'), compact(2, 'normal summary'), durable(3, 'sent Team input', true)];
  assert.equal(teamModelHistory(entries, current), entries);
});

test('resume filters only model state and retains visible transcript history across later clean compaction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-model-history-')), project = join(root, 'project');
  await mkdir(project);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const storageOptions = { projectRoot: project, pilotHome: join(root, 'home'), sessionId: 's' };
  const storage = createAgentProjectSessionStorage(storageOptions);
  const old = input(1, 'historical human request', { teamActivationId: 'team', teamStopVersion: 0 });
  const unknown = durable(2, 'unproven pending historical message');
  const summary = compact(3, 'old summary containing the unproven message');
  for (const entry of [old, unknown, summary, fresh(4)]) await storage.transcript.recordEntry(entry);
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: 'default', isSubagent: false, orchestrating: false, resolvedFrom: 'explicit', mutations: {} }),
    async *execute() {}, async *stream() {},
  };
  const options = { sessionId: 's', projectStorage: storageOptions,
    config: { provider: 'test', model: 'model', cwd: project, permissionMode: 'default' as const, permissionContext: createDefaultPermissionContext({ cwd: project, mode: 'default', canPrompt: false, bypassAvailable: true }) },
    dependencies: { router, tools: { registry: new ToolRegistry(), scheduler: { executeAll: async () => [] } } },
    modelHistoryEntries: (entries: AgentTranscriptEntry[]) => teamModelHistory(entries, current), collectFileArtifacts: false,
  };
  const first = await resumeAgentSession(options);
  assert.match(JSON.stringify(first.session.snapshot().messages), /current human input/);
  assert.doesNotMatch(JSON.stringify(first.session.snapshot().messages), /unproven|old summary/);
  const visible = [];
  for await (const event of first.session.replay()) visible.push(event);
  assert.match(JSON.stringify(visible), /old summary containing/);
  assert.match(JSON.stringify((await readTranscript(storage.transcriptPath)).entries), /unproven pending historical/);
  await first.session.dispose();
  const tailWriter = createAgentProjectSessionStorage(storageOptions).transcript;
  tailWriter.restoreState(4, null);
  await tailWriter.recordEntry(compact(5, 'clean current epoch summary'));
  const second = await resumeAgentSession(options);
  assert.match(JSON.stringify(second.session.snapshot().messages), /clean current epoch summary/);
  assert.doesNotMatch(JSON.stringify(second.session.snapshot().messages), /old summary|unproven pending/);
  await second.session.dispose();
});
