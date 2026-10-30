import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve('docs/testing/reports/2026-10-30-team-cases01-20');
async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}
const results = [];
const record = (name, passed, detail) => results.push({ name, passed, detail });
const files = await walk(root);
let json = 0;
let jsonl = 0;
let rows = 0;
const secrets = [];
const token = (await fs.readFile(path.join(os.homedir(), '.pilotdeck/server-token'), 'utf8')).trim();
for (const file of files.filter(file => /\.(?:json|jsonl|md|txt|log)$/.test(file))) {
  const text = await fs.readFile(file, 'utf8');
  if (/\.json$/.test(file)) { JSON.parse(text); json++; }
  if (/\.jsonl$/.test(file)) {
    for (const row of text.split('\n').filter(line => line.trim())) { JSON.parse(row); rows++; }
    jsonl++;
  }
  if ((token.length > 12 && text.includes(token)) || /(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN .*PRIVATE KEY-----)/.test(text)) secrets.push(path.relative(root, file));
}
record('JSON and JSONL parse', true, { json, jsonl, rows });
record('no server token or common credential patterns in evidence', secrets.length === 0, secrets);
const markdown = await fs.readFile(path.join(root, 'README.md'), 'utf8');
const missing = [];
for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
  const link = match[1].split('#')[0];
  if (!link || /^[a-z]+:\/\//i.test(link)) continue;
  if (!await fs.stat(path.resolve(root, decodeURIComponent(link))).catch(() => null)) missing.push(link);
}
record('report local links resolve', missing.length === 0, missing);
const scripts = (await fs.readdir('scripts')).filter(name => /^team-acceptance-.*-20261030\.mjs$/.test(name));
const syntax = scripts.map(name => ({ name, status: spawnSync(process.execPath, ['--check', path.join('scripts', name)], { encoding: 'utf8' }).status }));
record('acceptance scripts syntax', syntax.every(item => item.status === 0), syntax);
const runtime = JSON.parse(await fs.readFile(path.join(root, 'evidence/final/team-runtime.json'), 'utf8')).state;
const current = JSON.parse(await fs.readFile(path.join(os.homedir(), '.pilotdeck/team-runtime/state.json'), 'utf8')).state;
const counts = state => {
  const acts = Object.values(state.activations);
  return { activations: acts.length, turns: acts.reduce((n, a) => n + a.turns.length, 0), messages: acts.reduce((n, a) => n + a.messages.length, 0), dispatches: acts.reduce((n, a) => n + a.dispatches.length, 0), live: acts.flatMap(a => a.turns.filter(t => !t.endedAt).map(t => t.turnId)), pending: acts.flatMap(a => a.interactions.filter(i => i.status === 'pending').map(i => i.id)), queued: acts.flatMap(a => a.messages.filter(m => ['queued', 'preparing', 'sending'].includes(m.status)).map(m => m.id)) };
};
const finalCounts = counts(runtime);
const currentCounts = counts(current);
record('no execution caused by final read-only browser checks', JSON.stringify(finalCounts) === JSON.stringify(currentCounts), { final: finalCounts, current: currentCounts });
record('no live Team loop or pending internal work', !currentCounts.live.length && !currentCounts.pending.length && !currentCounts.queued.length, currentCounts);
record('fault switch absent', !await fs.stat(path.join(root, 'proxy-arm.json')).catch(() => null));
const ports = [3002, 18789, 3003].map(port => ({ port, listening: spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim().length > 0 }));
record('normal services available; fault proxy stopped', ports[0].listening && ports[1].listening && !ports[2].listening, ports);
const diff = spawnSync('git', ['diff', '--check', '--', 'docs/testing/reports', ...scripts.map(name => `scripts/${name}`)], { encoding: 'utf8' });
record('scoped git diff whitespace check', diff.status === 0, diff.stdout || diff.stderr || 'clean');
const report = { at: new Date().toISOString(), kind: 'artifact and cleanup verification, not product E2E', results };
await fs.writeFile(path.join(root, 'artifact-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
