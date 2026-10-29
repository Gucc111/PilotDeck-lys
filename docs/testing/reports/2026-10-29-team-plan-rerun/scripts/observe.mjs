import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';

const report = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = '/Users/gucc1/.pilotdeck';
const project = '/Users/gucc1/Codes/team-mode-acceptance/release-app';
const evidence = (name, data) => writeFileSync(resolve(report, 'evidence', name), JSON.stringify(data, null, 2) + '\n');
const [phase = 'observe', label = phase] = process.argv.slice(2);
const statePath = resolve(report, 'evidence', 'setup.json');
async function team(input) {
  const response = await fetch('http://127.0.0.1:3002/api/team-library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
if (phase === 'setup') {
  if (existsSync(statePath)) throw new Error('Setup already exists; do not duplicate.');
  const tools = ['read_file', 'write_file', 'edit_file', 'enter_plan_mode', 'exit_plan_mode', 'todo_write'];
  const profiles = [];
  for (const [index, role] of ['leader', 'reviewer', 'tester'].entries()) {
    const model = index === 0 ? { provider: 'llmcenter', model: 'claude-opus-4-8' } : { provider: 'llmcenter-openai', model: index === 1 ? 'deepseek-v4-pro-0813' : 'deepseek-v4.1-flash' };
    profiles.push(await team({ action: 'profile_save', role: index === 0 ? 'leader' : 'teammate', requestToken: randomUUID(), config: {
      displayName: `QA1029-Plan-${role}`, description: 'Plan 真实端到端验证',
      systemPrompt: index === 0 ? '你是验收团队 Leader。严格按本轮用户指令使用真实工具，不模拟。只在用户明确要求时派工，每位成员每轮最多委派一次，委派后立刻结束，不轮询。成员完成通知到达后仅收集和报告结果，不追加任务、不替成员审批。所有写入仅限验收项目的计划文件和 out/QA1029-* 标记文件，不修改产品代码或全局配置。' : '你是 Plan 验收成员。严格按派工指令使用真实工具。先真实 enter_plan_mode，在返回的目录写入计划，再真实 exit_plan_mode 等待用户。计划被拒绝或要求继续讨论后，不执行、不重新提交，简短报告决定并结束。获批才执行计划中的无害标记写入；需要权限时等待真人。所有写入仅限验收项目计划目录和 out/QA1029-*，不修改产品代码或全局配置。',
      model: { mode: 'model', ...model }, workspace: { mode: 'team' }, capabilities: { tools, skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default',
    } }));
  }
  const ref = p => ({ id: p.id, revision: p.revision });
  const saved = await team({ action: 'team_save', requestToken: randomUUID(), config: { displayName: 'QA1029-Plan', description: 'Case14/14A 定向复验', instructions: '依据真实工具结果完成验收，遵守用户批准或拒绝。', defaultProjectKey: project, leader: ref(profiles[0]), teammates: profiles.slice(1).map(ref) } });
  evidence('setup.json', { at: new Date().toISOString(), home, project, team: saved });
  const files = ['src/cli/createLocalGateway.ts', 'src/tool/planModeConstraints.ts', 'ui/dist/index.html'];
  evidence('baseline.json', { at: new Date().toISOString(), files: files.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) });
  console.log(JSON.stringify({ team: saved.config.displayName, id: saved.id, profiles: profiles.map(p => ({ id: p.id, name: p.config.displayName, tools: p.config.capabilities.tools, mode: p.config.permissionMode })) }, null, 2));
} else {
  const setup = JSON.parse(readFileSync(statePath, 'utf8'));
  const library = JSON.parse(readFileSync(resolve(home, 'team-runtime/state.json'), 'utf8')).state;
  const activation = Object.values(library.activations).find(a => a.team.id === setup.team.id);
  if (!activation) throw new Error('No UI-created activation yet.');
  const ws = new WebSocket('ws://127.0.0.1:18789/ws');
  const pending = new Map();
  await new Promise((ok, fail) => {
    ws.once('error', fail);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.1', clientName: 'QA1029-read-only-evidence', clientVersion: '1', token: readFileSync(resolve(home, 'server-token'), 'utf8').trim() })));
    ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.type === 'hello_ok') ok(); const waiter = pending.get(frame.id); if (waiter && frame.type === 'response') { pending.delete(frame.id); frame.ok ? waiter.resolve(frame.result) : waiter.reject(new Error(JSON.stringify(frame.error))); } });
  });
  async function request(method, params) {
    return new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ type: 'request', id, method, params })); });
  }
  try {
    const runtime = await team({ action: 'runtime_get', sessionKey: activation.sessionKey });
    const snapshot = await request('active_turn_snapshot', { sessionKey: activation.sessionKey, includeEvents: true });
    const history = await request('read_session_messages', { sessionKey: activation.sessionKey, projectKey: activation.storageProjectKey });
    const transcripts = [];
    for (const p of activation.participants.filter(p => p.role === 'teammate')) {
      transcripts.push({ id: p.id, name: p.profile.config.displayName, ...(await request('team_participant_messages', { sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, participantId: p.id, limit: 200 })) });
    }
    const files = ['out/QA1029-reviewer-approved.txt', 'out/QA1029-tester-declined.txt', 'out/QA1029-leader-approved.txt'].map(path => ({ path, exists: existsSync(resolve(project, path)), content: existsSync(resolve(project, path)) ? readFileSync(resolve(project, path), 'utf8') : null }));
    evidence(`${label}.json`, { at: new Date().toISOString(), runtime, snapshot, history, transcripts, files });
    console.log(JSON.stringify({ sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion, active: snapshot.active, interactions: runtime.activation.interactions.map(i => ({ id: i.id, member: i.participantDisplayName, kind: i.kind, status: i.status, resolution: i.resolution })), works: runtime.activation.works.map(w => ({ id: w.id, participantId: w.participantId, status: w.status, result: w.result })), files }, null, 2));
  } finally { ws.close(); }
}
