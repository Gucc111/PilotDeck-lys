import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const report = path.resolve('docs/testing/reports/2026-10-30-team-cases01-20');
const home = path.join(os.homedir(), '.pilotdeck');
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error('A simple evidence label is required');
const dir = path.join(report, 'evidence', label);
await fs.mkdir(dir, { recursive: true });
for (const area of ['team-runtime', 'team-library']) {
  const source = path.join(home, area, 'state.json');
  await fs.copyFile(source, path.join(dir, `${area}.json`));
}
const runtime = JSON.parse(await fs.readFile(path.join(dir, 'team-runtime.json'), 'utf8')).state;
const activations = Object.values(runtime.activations);
for (const activation of activations) {
  const contexts = path.join(home, 'team-runtime/contexts', activation.id);
  try { await fs.cp(contexts, path.join(dir, 'contexts', activation.id), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const projectDirs = await fs.readdir(path.join(home, 'projects'), { withFileTypes: true });
  for (const project of projectDirs.filter(item => item.isDirectory())) {
    const source = path.join(home, 'projects', project.name, 'chats', `${activation.sessionKey}.jsonl`);
    try { await fs.copyFile(source, path.join(dir, `${activation.sessionKey}.jsonl`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const sourceRoot = '/Users/gucc1/Codes/team-mode-acceptance';
for (const project of ['release-app', 'release-docs']) {
  try { await fs.cp(path.join(sourceRoot, project, 'out'), path.join(dir, project, 'out'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.writeFile(path.join(dir, 'observation.json'), JSON.stringify({ at: new Date().toISOString(), activations: activations.map(a => ({ id: a.id, session: a.sessionKey, stopVersion: a.stopVersion, status: a.status, messages: a.messages.length, turns: a.turns.length, dispatches: a.dispatches.length, interactions: a.interactions.length })) }, null, 2));
console.log(dir);
