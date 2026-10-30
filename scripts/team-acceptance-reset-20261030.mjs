import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

if (process.env.PILOTDECK_ACCEPTANCE_RESET_20261030 !== 'delete-old-team-data') {
  throw new Error('Destructive one-time preparation: explicitly set PILOTDECK_ACCEPTANCE_RESET_20261030=delete-old-team-data only when a fresh reset is intended.');
}

const repo = '/Users/gucc1/Codes/work/modelbest/PilotDeck-lys';
const home = path.join(os.homedir(), '.pilotdeck');
const fixture = '/Users/gucc1/Codes/team-mode-acceptance';
const report = path.join(repo, 'docs/testing/reports/2026-10-30-team-cases01-20');
const runtime = JSON.parse(await fs.readFile(path.join(home, 'team-runtime/state.json'), 'utf8')).state;
const sessions = new Set(Object.values(runtime.activations).map(item => item.sessionKey));
const targets = new Set();
for (const name of ['team-library', 'team-runtime', 'teams', 'teammates', 'team-sets', 'leader.md']) targets.add(path.join(home, name));
const reports = path.join(repo, 'docs/testing/reports');
for (const name of await fs.readdir(reports)) if (/^2026-10-(23|24|25|26|28|29)-team/.test(name)) targets.add(path.join(reports, name));
for (const name of await fs.readdir(os.tmpdir())) if (/^pilotdeck-team-communication-/.test(name)) targets.add(path.join(os.tmpdir(), name));
for (const name of ['evidence', 'empty-home', 'fault-home', 'legacy-home', 'legacy-backup-failure-home']) targets.add(path.join(fixture, name));
for (const name of ['release-app', 'release-docs']) {
  const dir = path.join(fixture, name);
  for (const child of await fs.readdir(dir)) if (child === 'out' || /^qa\d{4}-/.test(child) || child === '__pycache__') targets.add(path.join(dir, child));
}
for (const name of ['mcp-logs', 'backups']) targets.add(path.join(home, 'team-mode-test', name));
for (const name of await fs.readdir(path.join(home, 'team-mode-test'))) if (/^(qa\d|case\d)/.test(name)) targets.add(path.join(home, 'team-mode-test', name));
for (const name of await fs.readdir(path.join(fixture, 'support'))) if (/requests\.json$|acceptance-before-directory-cleanup/.test(name)) targets.add(path.join(fixture, 'support', name));

const chats = [];
const projects = path.join(home, 'projects');
for (const project of await fs.readdir(projects)) {
  const dir = path.join(projects, project);
  for (const area of ['chats', 'pending-inputs']) {
    const parent = path.join(dir, area);
    let names;
    try { names = await fs.readdir(parent); } catch { continue; }
    for (const name of names) {
      const file = path.join(parent, name);
      if (!(await fs.stat(file)).isFile()) continue;
      const content = await fs.readFile(file, 'utf8');
      if (project.includes('team-mode-acceptance') || /teamActivationId|team_delegate|team_send_message|team_followup|team_relay_message|QA102[34689]/.test(content)
        || [...sessions].some(id => name.includes(id.replace(/[\\/]/g, '-')))) {
        targets.add(file); chats.push(file);
      }
    }
  }
}
const screenshots = path.join(home, '.pilotdeck/browser_screenshots');
for (const session of sessions) targets.add(path.join(screenshots, session));
await fs.mkdir(report, { recursive: true });
let removed = 0;
const records = [];
for (const target of targets) {
  try {
    const stat = await fs.stat(target);
    await fs.rm(target, { recursive: true, force: true });
    records.push({ path: target, directory: stat.isDirectory() }); removed++;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const name of ['release-app', 'release-docs']) {
  const baseline = path.join(fixture, 'baselines', name);
  await fs.cp(baseline, path.join(fixture, name), { recursive: true });
}
await fs.mkdir(path.join(home, 'team-mode-test/mcp-logs'), { recursive: true });
await fs.writeFile(path.join(report, 'cleanup.json'), JSON.stringify({ date: '2026-10-30', removed, chats: chats.length,
  oldSessions: sessions.size, removedPaths: records, preserved: ['provider credentials and general configuration', 'non-Team chats', 'acceptance baseline source files', 'MCP test server and skill fixtures'] }, null, 2) + '\n');
console.log(JSON.stringify({ removed, chats: chats.length, oldSessions: sessions.size, report }));
