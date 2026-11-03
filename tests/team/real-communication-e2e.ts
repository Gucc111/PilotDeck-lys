/** Opt-in real provider acceptance. Credentials stay in the disposable home. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import WebSocket from 'ws';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { createProjectId } from '../../src/pilot/index.js';
import type { AgentProfile, ProfileConfig, TeamDefinition } from '../../src/team/types.js';
import type { TeamRuntimeView } from '../../src/team/runtimeTypes.js';

if (process.env.PILOTDECK_RUN_REAL_TEAM_COMMUNICATION !== '1') throw new Error('Set PILOTDECK_RUN_REAL_TEAM_COMMUNICATION=1 to use real providers.');
const base = await mkdtemp(join(tmpdir(), 'pilotdeck-team-communication-'));
const leaderProvider = process.env.PILOTDECK_TEAM_REAL_LEADER_PROVIDER ?? 'llmcenter-openai';
const leaderModel = process.env.PILOTDECK_TEAM_REAL_LEADER_MODEL ?? 'gpt-5.6-sol';
const home = join(base, 'home'), workspace = join(base, 'workspaces', 'Login compatibility');
await mkdir(join(home, 'skills'), { recursive: true }); await mkdir(workspace, { recursive: true });
const original = YAML.parse(await readFile(join(homedir(), '.pilotdeck', 'pilotdeck.yaml'), 'utf8'));
await writeFile(join(home, 'pilotdeck.yaml'), YAML.stringify({ schemaVersion: 1,
  agent: { model: `${leaderProvider}/${leaderModel}`, maxContextTokens: 65536, maxOutputTokens: 4096 }, model: original.model,
  extension: { builtinPluginsEnabled: { 'windows-skills': false, 'browser-use': false, funasr: false } },
  memory: { enabled: false }, telemetry: { enabled: false }, router: { enabled: false },
  webui: { runtime: { workspacesRoot: join(base, 'workspaces'), databasePath: join(home, 'auth.db') } },
}), { mode: 0o600 });
const registration = join(home, 'projects', createProjectId(workspace));
await mkdir(registration, { recursive: true }); await writeFile(join(registration, '.cwd'), workspace);
await writeFile(join(workspace, 'login.js'), 'export function login(username, password) { return { username, password }; }\n');
const local = createLocalGateway({ pilotHome: home, projectRoot: workspace, fallbackProjectRoot: home, builtinSkillsRoot: join(home, 'skills'), env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: undefined, PILOT_AGENT_MODEL: undefined } });
const auth = randomUUID(); await writeFile(join(home, 'server-token'), auth, { mode: 0o600 });
const server = await startGatewayServer({ gateway: local.gateway, host: '127.0.0.1', port: 0, token: auth }); local.bindServer(server);
const socket = new WebSocket(server.wsUrl), pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; events: any[] }>();
const evidence: unknown[] = [];
const connected = new Promise<void>((resolve, reject) => {
  socket.once('error', reject);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', protocolVersion: '1.1', clientName: 'team-communication-real', clientVersion: '1', token: auth })));
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'hello_ok') { resolve(); return; }
    evidence.push(frame);
    const waiter = pending.get(frame.id); if (!waiter) return;
    if (frame.type === 'response') { pending.delete(frame.id); frame.ok ? waiter.resolve(frame.result) : waiter.reject(new Error(JSON.stringify(frame.error))); }
    if (frame.type === 'event') { waiter.events.push(frame.event); if (frame.final) { pending.delete(frame.id); waiter.resolve(waiter.events); } }
  });
  socket.on('close', () => {
    reject(new Error('Gateway closed before handshake.'));
    for (const waiter of pending.values()) waiter.reject(new Error('Gateway disconnected.'));
    pending.clear();
  });
});
function request(method: string, params: unknown): Promise<any> {
  const id = randomUUID(); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, events: [] }); socket.send(JSON.stringify({ type: 'request', id, method, params })); });
}
const timeout = setTimeout(() => { console.error('Real Team acceptance timed out', base); void shutdown(1); }, 480_000);
async function shutdown(code = 0) {
  clearTimeout(timeout); socket.close(); await local.dispose(); await server.close(); process.exit(code);
}
process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
try {
  await connected;
  const profile = async (role: 'leader' | 'teammate', displayName: string, provider: string, model: string, systemPrompt: string, tools: string[]) => request('team_command', { action: 'profile_save', role, requestToken: randomUUID(), config: { displayName, description: '', model: { mode: 'model', provider, model }, systemPrompt, workspace: { mode: 'team' }, capabilities: { tools, skills: [], mcpServers: [] }, permissionMode: 'bypassPermissions' } satisfies ProfileConfig }) as Promise<AgentProfile>;
  const leader = await profile('leader', 'Release lead', leaderProvider, leaderModel, 'Coordinate only the requested login.js compatibility change. Send separate instructions to Developer and Reviewer. Developer must directly ask Reviewer and receive a direct reply. Read every relevant final result with team_turns specifying participantId and turnId, then give the user a concise final answer. Avoid repeated assignments and do not send acknowledgements that start unnecessary work.', []);
  const developer = await profile('teammate', 'Developer', 'llmcenter-openai', 'deepseek-v4-pro-0813', 'Change only login.js. Before editing, directly ask Reviewer via team_send_message whether the old login(username,password) signature must remain supported. If there is no reply yet, end this execution and continue when the reply arrives. After the explicit reply, support both login(username,password) and login({username,password}) and preserve the returned object. Use read_file and edit_file or write_file. Put the final result only in your final answer. Do not send a result message to the Leader.', ['read_file', 'write_file', 'edit_file']);
  const reviewer = await profile('teammate', 'Reviewer', 'llmcenter-openai', 'deepseek-v4.1-flash', 'The requirement is to retain old login(username,password) and additionally support login({username,password}). When Developer asks, send this requirement directly to Developer using team_send_message. Do not ask more questions and do not send a separate status message to Leader. Put any final work result in your final answer. Do not edit files.', ['read_file']);
  const team = await request('team_command', { action: 'team_save', requestToken: randomUUID(), config: { displayName: 'Communication acceptance', description: '', instructions: 'This is a small finite compatibility change. Use direct communication for the compatibility question. End each execution when it has no independent work. Do not keep exchanging acknowledgements.', defaultProjectKey: workspace, leader: { id: leader.id }, teammates: [{ id: developer.id }, { id: reviewer.id }] } }) as TeamDefinition;
  const { sessionKey } = await request('new_session', { projectKey: workspace, channelKey: 'web' });
  const selected = await request('team_command', { action: 'runtime_select', sessionKey, storageProjectKey: workspace, team: { id: team.id }, requestToken: randomUUID() }) as TeamRuntimeView;
  await writeFile(join(base, 'fixture.json'), JSON.stringify({ base, home, workspace, sessionKey, teamId: team.id, leaderId: leader.id, developerId: developer.id, reviewerId: reviewer.id, gatewayUrl: server.wsUrl }, null, 2));
  console.log(JSON.stringify({ phase: 'ready', base, gatewayUrl: server.wsUrl, sessionKey }));
  await request('submit_turn', { sessionKey, projectKey: workspace, channelKey: 'web', runId: randomUUID(), teamActivationId: selected.activation!.id, teamStopVersion: selected.activation!.stopVersion, message: 'Update login.js to support an object argument while preserving the old two-argument API and return object. Ask Developer to directly confirm compatibility with Reviewer before editing. Query the saved member results before reporting completion.', maxTurns: 15 });
  let view: TeamRuntimeView | undefined;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    view = await request('team_command', { action: 'runtime_get', sessionKey, limit: 200 });
    const a = view!.activation!;
    if (a.turns?.some(turn => turn.participantId === developer.id && turn.finalMessage) && !a.turns.some(turn => ['preparing', 'running', 'waiting_approval'].includes(turn.status)) && !a.messages.some(message => ['queued', 'preparing'].includes(message.status) && !message.error)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const activation = view!.activation!;
  const source = await readFile(join(workspace, 'login.js'), 'utf8');
  const login = (await import(`file://${join(workspace, 'login.js')}?v=${Date.now()}`)).login;
  assert.deepEqual(login('a', 'b'), { username: 'a', password: 'b' });
  assert.deepEqual(login({ username: 'a', password: 'b' }), { username: 'a', password: 'b' });
  assert.ok(activation.messages.some(message => message.senderId === developer.id && message.recipientId === reviewer.id && message.status === 'consumed'), 'Developer directly asked Reviewer');
  assert.ok(activation.messages.some(message => message.senderId === reviewer.id && message.recipientId === developer.id && message.status === 'consumed'), 'Reviewer directly replied to Developer');
  assert.ok(activation.dispatches?.every(dispatch => dispatch.status !== 'consumed' || dispatch.dispatchedAt), 'Actual dispatches have timestamps');
  assert.ok(!activation.turns?.some(turn => ['preparing', 'running', 'waiting_approval'].includes(turn.status)), 'No active loops remain');
  const leaderTurns = activation.turns?.filter(turn => turn.participantId === leader.id) ?? [];
  assert.ok(leaderTurns.at(-1)?.finalMessage?.content.some(block => block.type === 'text' && block.text.trim()), 'Leader saved a formal final answer');
  const transcript = await readFile(join(registration, 'chats', sessionKey.replace(/[\\/]/g, '-') + '.jsonl'), 'utf8');
  const entries = transcript.trim().split('\n').map(line => JSON.parse(line));
  const inspected = entries.filter(entry => entry.type === 'assistant_message').flatMap(entry => entry.message.content).filter(block => block.type === 'tool_call' && block.name === 'team_turns' && block.input?.participantId && block.input?.turnId);
  for (const participant of [developer, reviewer]) assert.ok(inspected.some(block => block.input.participantId === participant.id && activation.turns?.some(turn => turn.participantId === participant.id && turn.turnId === block.input.turnId)), 'Leader queried exact saved member results');
  await writeFile(join(base, 'result.json'), JSON.stringify({ passed: true, base, sessionKey, activationId: activation.id, source, messages: activation.messages, turns: activation.turns, dispatches: activation.dispatches }, null, 2));
  await writeFile(join(base, 'gateway-events.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ phase: 'passed', base, sessionKey, turns: activation.turns?.length, messages: activation.messages.length, dispatches: activation.dispatches?.length }));
  if (process.env.PILOTDECK_KEEP_REAL_TEAM_SERVER === '1') { clearTimeout(timeout); console.log('Server retained for browser validation.'); }
  else await shutdown();
} catch (error) {
  await writeFile(join(base, 'failure.json'), JSON.stringify({ message: String(error), evidence }, null, 2));
  console.error(String(error), base); await shutdown(1);
}
