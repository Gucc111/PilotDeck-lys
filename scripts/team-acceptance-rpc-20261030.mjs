import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayWsClient } from '../dist/src/gateway/client/GatewayWsClient.js';
import { RemoteGateway } from '../dist/src/gateway/client/RemoteGateway.js';

const report = path.resolve('docs/testing/reports/2026-10-30-team-cases01-20');
const pilotHome = path.join(os.homedir(), '.pilotdeck');
const mode = process.argv[2];
const token = (await fs.readFile(path.join(pilotHome, 'server-token'), 'utf8')).trim();
const client = new GatewayWsClient({ url: 'ws://127.0.0.1:18789/ws', token, clientName: 'cli' });
await client.connect();
const gateway = new RemoteGateway(client);
const rows = [];
async function call(label, method, input) {
  try {
    const result = await gateway[method](input);
    rows.push({ label, input, ok: true, result });
    return result;
  } catch (error) {
    rows.push({ label, input, ok: false, code: error.code, message: error.message });
  }
}
try {
  if (mode === 'interaction-identity') {
    const state = JSON.parse(await fs.readFile(path.join(pilotHome, 'team-runtime/state.json'), 'utf8')).state;
    const activation = Object.values(state.activations).findLast(a => a.interactions.some(i => i.status === 'pending'));
    const item = activation?.interactions.find(i => i.status === 'pending');
    if (!item) throw new Error('A real pending interaction is required');
    const base = { action: 'runtime_interaction_respond', sessionKey: item.sessionKey, activationId: item.activationId, stopVersion: item.stopVersion, participantId: item.participantId, interactionId: item.id, requestId: item.requestId, kind: item.kind, decision: 'cancel' };
    const changes = { sessionKey: 'web:s_wrong-owner', activationId: randomUUID(), stopVersion: item.stopVersion + 1, participantId: randomUUID(), interactionId: randomUUID(), requestId: randomUUID(), kind: item.kind === 'user_question' ? 'plan_approval' : 'user_question' };
    for (const [field, value] of Object.entries(changes)) {
      await call(`wrong-${field}`, 'teamInteractionRespond', { ...base, [field]: value });
      const view = await gateway.teamCommand({ action: 'runtime_get', sessionKey: item.sessionKey });
      rows.push({ label: `readback-${field}`, pending: view.activation.interactions.find(i => i.id === item.id)?.status });
    }
  } else if (mode === 'config-validation') {
    const library = await gateway.teamCommand({ action: 'library' });
    const leader = library.profiles.find(p => p.role === 'leader');
    const teammate = library.profiles.find(p => p.role === 'teammate');
    const team = library.teams[0];
    const invalidProfiles = {
      'empty-name': { ...leader.config, displayName: '' },
      'empty-prompt': { ...leader.config, systemPrompt: '' },
      'default-model': { ...leader.config, model: { mode: 'default' } },
      'duplicate-tools': { ...leader.config, capabilities: { ...leader.config.capabilities, tools: ['read_file', 'read_file'] } },
      'retired-optional-field': { ...leader.config, optionalCapabilities: [{ kind: 'tool', name: 'not-selected' }] },
    };
    for (const [label, config] of Object.entries(invalidProfiles)) await call(label, 'teamCommand', { action: 'profile_save', role: 'leader', config, requestToken: randomUUID() });
    for (const [label, config] of Object.entries({ 'wrong-leader-role': { ...team.config, leader: { id: teammate.id } }, 'wrong-teammate-role': { ...team.config, teammates: [{ id: leader.id }] }, 'duplicate-members': { ...team.config, teammates: [{ id: teammate.id }, { id: teammate.id }] }, 'empty-members': { ...team.config, teammates: [] } })) await call(label, 'teamCommand', { action: 'team_save', config, requestToken: randomUUID() });
    await call('immutable-role', 'teamCommand', { action: 'profile_save', id: leader.id, role: 'teammate', config: leader.config, requestToken: randomUUID() });
    const firstInput = { action: 'profile_fork', source: { id: leader.id }, displayName: 'RPC 临时配置 A', requestToken: randomUUID() };
    const a = await call('fork', 'teamCommand', firstInput);
    await call('fork-identical-retry', 'teamCommand', firstInput);
    await call('fork-token-conflict', 'teamCommand', { ...firstInput, displayName: 'changed-token-body' });
    const saveA = { action: 'profile_save', id: a.id, role: a.role, config: { ...a.config, description: 'SAVE_A_17' }, requestToken: randomUUID() };
    await call('save-A', 'teamCommand', saveA);
    await call('save-B', 'teamCommand', { ...saveA, config: { ...a.config, description: 'SAVE_B_29' }, requestToken: randomUUID() });
    await call('replay-A', 'teamCommand', saveA);
    const current = await gateway.teamCommand({ action: 'library' });
    rows.push({ label: 'latest-after-replay', result: current.profiles.find(p => p.id === a.id) });
    await call('delete-test-role', 'teamCommand', { action: 'profile_delete', id: a.id, requestToken: randomUUID() });
  } else if (mode === 'prepare-preflight') {
    const library = await gateway.teamCommand({ action: 'library' });
    const base = library.teams.find(t => t.config.displayName === '发布评审团队');
    const missing = await call('missing-model-profile', 'teamCommand', { action: 'profile_save', role: 'leader', config: { ...base.leader.config, displayName: 'Case08 缺失模型', model: { mode: 'model', provider: 'acceptance-missing', model: 'missing-model' } }, requestToken: randomUUID() });
    await call('missing-model-team', 'teamCommand', { action: 'team_save', config: { ...base.config, displayName: 'Case08 必需模型缺失', leader: { id: missing.id } }, requestToken: randomUUID() });
    const required = await call('required-skill-profile', 'teamCommand', { action: 'profile_save', role: 'leader', config: { ...base.leader.config, displayName: 'Case08 必需技能', capabilities: { ...base.leader.config.capabilities, tools: ['read_file', 'read_skill'], skills: ['release-checklist'] } }, requestToken: randomUUID() });
    await call('required-skill-team', 'teamCommand', { action: 'team_save', config: { ...base.config, displayName: 'Case08 必需技能缺失', leader: { id: required.id } }, requestToken: randomUUID() });
    const fixed = await call('fixed-P2-profile', 'teamCommand', { action: 'profile_save', role: 'leader', config: { ...base.leader.config, displayName: 'Case07 固定P2', workspace: { mode: 'fixed', projectKey: '/Users/gucc1/Codes/team-mode-acceptance/release-docs' } }, requestToken: randomUUID() });
    await call('fixed-P2-team', 'teamCommand', { action: 'team_save', config: { ...base.config, displayName: 'Case07 工作区冲突', leader: { id: fixed.id } }, requestToken: randomUUID() });
  } else if (mode === 'replay-independent-saves') {
    const library = await gateway.teamCommand({ action: 'library' });
    const state = JSON.parse(await fs.readFile(path.join(pilotHome, 'team-library/state.json'), 'utf8')).state;
    for (const [kind, marker] of [['profile', 'CASE02_ROLE_A_61'], ['team', 'CASE02_INDEPENDENT_TEAM_A_83']]) {
      const receipt = state.receipts.find(r => r.result.config?.description === marker);
      const saved = receipt.result;
      await call(`replay-browser-${kind}-A`, 'teamCommand', { action: `${kind}_save`, id: saved.id, ...(kind === 'profile' ? { role: saved.role } : {}), config: saved.config, requestToken: receipt.token });
      const latest = await gateway.teamCommand({ action: 'library' });
      rows.push({ label: `${kind}-after-old-replay`, description: latest[kind === 'profile' ? 'profiles' : 'teams'].find(item => item.id === saved.id).config.description });
    }
    rows.push({ label: 'before-counts', profiles: library.profiles.length, teams: library.teams.length });
  } else if (mode === 'config-negative-extra') {
    const library = await gateway.teamCommand({ action: 'library' });
    const leader = library.profiles.find(p => p.role === 'leader');
    const team = library.teams[0];
    for (const [label, extra] of Object.entries({ revision: { revision: 1 }, expectedRevision: { expectedRevision: 1 }, archived: { archived: true }, unknown: { unknownField: true } })) {
      await call(`profile-${label}`, 'teamCommand', { action: 'profile_save', id: leader.id, role: leader.role, config: leader.config, requestToken: randomUUID(), ...extra });
      await call(`team-${label}`, 'teamCommand', { action: 'team_save', id: team.id, config: team.config, requestToken: randomUUID(), ...extra });
    }
    await call('forged-profile-id', 'teamCommand', { action: 'profile_save', id: randomUUID(), role: leader.role, config: leader.config, requestToken: randomUUID() });
    await call('forged-team-id', 'teamCommand', { action: 'team_save', id: randomUUID(), config: team.config, requestToken: randomUUID() });
    await call('missing-member', 'teamCommand', { action: 'team_save', config: { ...team.config, teammates: [{ id: randomUUID() }] }, requestToken: randomUUID() });
    for (const action of ['profile_archive', 'team_archive']) await call(action, 'teamCommand', { action, id: action === 'profile_archive' ? leader.id : team.id, requestToken: randomUUID() });
    const after = await gateway.teamCommand({ action: 'library' });
    rows.push({ label: 'counts', before: { profiles: library.profiles.length, teams: library.teams.length }, after: { profiles: after.profiles.length, teams: after.teams.length } });
  } else if (mode === 'prepare-extra') {
    const library = await gateway.teamCommand({ action: 'library' });
    const base = library.teams.find(t => t.config.displayName === '发布评审团队');
    const tester = library.profiles.find(p => p.id === '12e0d7ec-07ff-4324-a1d3-04ebd5808a7f');
    const fixed = await call('fixed-P2-teammate', 'teamCommand', { action: 'profile_save', role: 'teammate', config: { ...tester.config, displayName: 'Case07 P2测试员', workspace: { mode: 'fixed', projectKey: '/Users/gucc1/Codes/team-mode-acceptance/release-docs' } }, requestToken: randomUUID() });
    await call('fixed-P2-teammate-team', 'teamCommand', { action: 'team_save', config: { ...base.config, displayName: 'Case07 成员固定P2', teammates: [{ id: fixed.id }] }, requestToken: randomUUID() });
    for (const [label, capabilities] of Object.entries({
      '必需技能缺失': { tools: ['read_file', 'read_skill'], skills: ['case08-required-absent'], mcpServers: [] },
      '必需MCP缺失': { tools: ['read_file'], skills: [], mcpServers: ['case08-required-absent'] },
      '必需工具缺失': { tools: ['case08-required-absent'], skills: [], mcpServers: [] },
    })) {
      const profile = await call(`${label}-profile`, 'teamCommand', { action: 'profile_save', role: 'leader', config: { ...base.leader.config, displayName: `Case08 ${label}`, capabilities }, requestToken: randomUUID() });
      await call(`${label}-team`, 'teamCommand', { action: 'team_save', config: { ...base.config, displayName: `Case08 ${label}`, leader: { id: profile.id } }, requestToken: randomUUID() });
      const probe = await call(`${label}-probe`, 'teamCommand', { action: 'runtime_probe', team: { id: rows.at(-1).result.id }, projectKey: '/Users/gucc1/Codes/team-mode-acceptance/release-app' });
      if (probe) await call(`${label}-direct-select`, 'teamCommand', { action: 'runtime_select', team: { id: probe.team.id }, sessionKey: `web:s_${randomUUID()}`, projectKey: probe.projectKey, storageProjectKey: probe.projectKey, requestToken: randomUUID(), probeFingerprint: probe.fingerprint });
    }
  } else if (mode === 'routing-validation') {
    const sessionKey = 'web:s_278ee90e-a533-4986-b401-7e7722456a60';
    const view = await gateway.teamCommand({ action: 'runtime_get', sessionKey });
    const activation = view.activation;
    const team = { id: activation.team.id };
    const projectKey = activation.projectKey;
    const p2 = '/Users/gucc1/Codes/team-mode-acceptance/release-docs';
    const p0 = '/Users/gucc1/Codes/team-mode-acceptance/unregistered';
    const before = { turns: activation.turns.length, dispatches: activation.dispatches.length };
    for (const bad of [p2, p0]) {
      await call(`probe-storage-${bad === p2 ? 'P2' : 'P0'}`, 'teamCommand', { action: 'runtime_probe', sessionKey, storageProjectKey: bad, projectKey, team });
      await call(`probe-execution-${bad === p2 ? 'P2' : 'P0'}`, 'teamCommand', { action: 'runtime_probe', sessionKey, storageProjectKey: projectKey, projectKey: bad, team });
      await call(`select-storage-${bad === p2 ? 'P2' : 'P0'}`, 'teamCommand', { action: 'runtime_select', sessionKey, storageProjectKey: bad, projectKey, team, requestToken: randomUUID() });
      const events = [];
      try { for await (const event of gateway.submitTurn({ sessionKey, channelKey: 'web', runId: randomUUID(), message: 'Invalid location request: never execute.', teamActivationId: activation.id, teamStopVersion: activation.stopVersion, projectKey: bad, workspaceCwd: bad })) events.push(event); }
      catch (error) { events.push({ code: error.code, message: error.message }); }
      rows.push({ label: `submit-location-${bad === p2 ? 'P2' : 'P0'}`, events });
    }
    const after = (await gateway.teamCommand({ action: 'runtime_get', sessionKey })).activation;
    rows.push({ label: 'before-after', before, after: { turns: after.turns.length, dispatches: after.dispatches.length, storageProjectKey: after.storageProjectKey, projectKey: after.projectKey } });
  } else if (mode === 'accepted-replay') {
    const sessionKey = 'web:s_278ee90e-a533-4986-b401-7e7722456a60';
    const transcriptPath = path.join(pilotHome, 'projects/Users-gucc1-Codes-team-mode-acceptance-release-app/chats', `${sessionKey}.jsonl`);
    const entries = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const accepted = entries.find(e => e.type === 'accepted_input' && e.messages?.some(m => m.content?.some(c => c.text?.startsWith('CASE19_NEW'))));
    if (!accepted) throw new Error('Real accepted UI input required');
    const input = { sessionKey, channelKey: 'web', runId: accepted.turnId, message: accepted.messages[0].content[0].text, uploadedAttachments: [], projectKey: '/Users/gucc1/Codes/team-mode-acceptance/release-app', teamActivationId: accepted.metadata.teamActivationId, teamStopVersion: accepted.metadata.teamStopVersion };
    async function submit(label, body) {
      const events = [];
      try { for await (const event of gateway.submitTurn(body)) events.push(event); rows.push({ label, input: body, events }); }
      catch (error) { rows.push({ label, input: body, code: error.code, message: error.message, events }); }
    }
    const before = await gateway.teamCommand({ action: 'runtime_get', sessionKey });
    const count = view => ({ turns: view.activation.turns.length, dispatches: view.activation.dispatches.length, stopVersion: view.activation.stopVersion, messages: view.activation.messages.length });
    rows.push({ label: 'before', counts: count(before) });
    await submit('accepted-old-generation-replay', input);
    await submit('accepted-identical-replay-again', input);
    await submit('accepted-token-changed-text', { ...input, message: `${input.message} changed body` });
    await submit('unaccepted-old-generation', { ...input, runId: randomUUID(), message: 'Must be rejected before acceptance.' });
    await call('old-abort-after-current-work', 'abortTurn', { sessionKey, teamActivationId: input.teamActivationId, teamStopVersion: input.teamStopVersion });
    const after = await gateway.teamCommand({ action: 'runtime_get', sessionKey });
    rows.push({ label: 'after', counts: count(after), acceptedCount: (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'accepted_input' && e.turnId === input.runId).length });
  } else if (mode === 'deleted-config-replay') {
    const state = JSON.parse(await fs.readFile(path.join(pilotHome, 'team-library/state.json'), 'utf8')).state;
    const profileId = 'b7f21a63-9f69-4610-8bb6-28e1bff17c07';
    const teamA = 'ef9ee930-0a7c-4524-b200-1d169756bc0d';
    const teamB = '8c6f39e0-6410-4505-833f-5131faadee63';
    const removedActiveTeam = '8ef95834-ed57-4a19-8f5f-394b5682f9fc';
    const saved = state.receipts.find(r => r.token === 'a8f8c27b-5d87-4504-be7d-4027061f0529');
    await call('deleted-profile-old-save', 'teamCommand', { action: 'profile_save', id: profileId, role: saved.result.role, config: saved.result.config, requestToken: saved.token });
    const forked = state.receipts.find(r => r.token === 'ca7f4e04-731f-4633-bc29-5be15525f32b');
    await call('deleted-profile-old-fork', 'teamCommand', { action: 'profile_fork', source: { id: '0cfc02bc-b099-42ff-97e7-db3c1ca49292' }, displayName: forked.result.config.displayName, requestToken: forked.token });
    const createdTeam = state.receipts.find(r => r.result?.id === teamA && r.result.config.displayName === 'Case05 双引用 A');
    await call('deleted-team-old-create', 'teamCommand', { action: 'team_save', config: createdTeam.result.config, requestToken: createdTeam.token });
    const forkedTeam = state.receipts.find(r => r.result?.id === teamB);
    await call('deleted-team-old-fork', 'teamCommand', { action: 'team_fork', source: { id: teamA }, displayName: forkedTeam.result.config.displayName, requestToken: forkedTeam.token });
    for (const id of [teamA, teamB, removedActiveTeam]) await call(`deleted-team-probe-${id}`, 'teamCommand', { action: 'runtime_probe', team: { id }, projectKey: '/Users/gucc1/Codes/team-mode-acceptance/release-app' });
    const current = await gateway.teamCommand({ action: 'library' });
    rows.push({ label: 'deleted-identities-remain-absent', profilePresent: current.profiles.some(p => p.id === profileId), teamsPresent: current.teams.filter(t => [teamA, teamB, removedActiveTeam].includes(t.id)).map(t => t.id) });
  } else if (mode === 'snapshot') {
    rows.push({ label: 'server', result: await gateway.describeServer() });
  } else {
    throw new Error('Unknown acceptance RPC mode');
  }
  await fs.writeFile(path.join(report, `${mode}.json`), JSON.stringify({ at: new Date().toISOString(), evidenceKind: 'real Gateway auxiliary replay, not browser E2E', rows }, null, 2));
  console.log(JSON.stringify(rows.map(r => ({ label: r.label, ok: r.ok, code: r.code, pending: r.pending })), null, 2));
} finally {
  client.close();
}
