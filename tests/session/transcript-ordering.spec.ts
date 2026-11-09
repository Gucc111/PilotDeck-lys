import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlTranscriptWriter } from '../../src/session/transcript/JsonlTranscriptWriter.js';
import { readTranscript } from '../../src/session/transcript/TranscriptReader.js';

const stamp = '2026-11-07T00:00:00.000Z';
const metadata = (title: string) => ({ title });

test('shared transcript coordinator serializes concurrent writers and resumes after close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilotdeck-ordering-'));
  const path = join(dir, 'session.jsonl');
  try {
    const first = new JsonlTranscriptWriter({ path });
    const second = new JsonlTranscriptWriter({ path });
    await Promise.all([
      first.recordSessionMetadata('s', 't', metadata('first')),
      second.recordAgentStatusMessage('s', 't', { event: 'status', kind: 'status', text: 'second' }),
      first.recordSessionMetadata('s', 't', metadata('third')),
    ]);
    await Promise.all([first.close(), second.close()]);
    const resumed = new JsonlTranscriptWriter({ path, now: () => new Date(stamp) });
    await resumed.recordSessionMetadata('s', 't', metadata('resumed'));
    await resumed.close();
    const raw = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(raw.map(entry => entry.sequence), [1, 2, 3, 4]);
    assert.deepEqual(raw.map(entry => entry.transcriptOrder), [1, 2, 3, 4]);
    assert.equal(raw[0].parentEntryId, null);
    assert.equal(raw[1].parentEntryId, raw[0].entryId);
    assert.equal(raw[2].parentEntryId, raw[1].entryId);
    assert.equal(raw[3].parentEntryId, raw[2].entryId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy duplicate sequences retain physical append order while preserving references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilotdeck-legacy-ordering-'));
  const path = join(dir, 'session.jsonl');
  try {
    const first = { type: 'accepted_input', sessionId: 's', turnId: 't', sequence: 1, createdAt: stamp, entryId: 'first', parentEntryId: null, messages: [] };
    const second = { type: 'agent_status_message', sessionId: 's', turnId: 't', sequence: 1, createdAt: stamp, entryId: 'late', parentEntryId: 'first', event: 'status', kind: 'status', text: 'late status' };
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const result = await readTranscript(path);
    assert.deepEqual(result.entries.map(entry => entry.entryId), ['first', 'late']);
    assert.deepEqual(result.entries.map(entry => entry.transcriptOrder), [1, 2]);
    assert.equal((result.entries[1] as any).parentEntryId, 'first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
