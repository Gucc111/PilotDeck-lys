import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Windows writes flush the file and rename without attempting unsupported directory fsync', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'team-windows-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Isolate platform/fs shims in a child so other suites keep the real filesystem.
  const script = `
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const directory = process.argv[1];
const originalOpen = fsPromises.open;
let fileSyncs = 0;
fsPromises.open = async (...args) => {
  if (args[1] === 'r' && (await fsPromises.stat(args[0])).isDirectory()) throw Object.assign(new Error('Directory open unsupported on Windows'), { code: 'EPERM' });
  const handle = await originalOpen(...args);
  const sync = handle.sync.bind(handle);
  handle.sync = async () => { fileSyncs++; await sync(); };
  return handle;
};
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', { value: 'win32' });
const { TeamStore } = await import('./src/team/store.ts');
const store = new TeamStore(directory);
await store.locked(async () => { await store.write({ version: 2, profiles: {}, teams: {}, receipts: [] }); });
assert.equal((await store.read()).version, 2);
assert.equal(fileSyncs, 3);
`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
});
