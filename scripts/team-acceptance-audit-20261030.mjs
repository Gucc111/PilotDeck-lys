import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const report = path.resolve('docs/testing/reports/2026-10-30-team-cases01-20');
const home = path.join(os.homedir(), '.pilotdeck');
const runtime = JSON.parse(await fs.readFile(path.join(report, 'evidence/final/team-runtime.json'), 'utf8')).state;
const library = JSON.parse(await fs.readFile(path.join(report, 'evidence/final/team-library.json'), 'utf8')).state;
const rows = [];
const check = (name, passed, detail) => rows.push({ name, passed, detail });
const acts = Object.values(runtime.activations);
const main = runtime.activations['7610ca21-9e69-4a0e-aa37-1561ed24ff53'];
const business = runtime.activations['4950802c-3967-4e8f-8556-57d72810ae63'];
const findMessage = id => acts.flatMap(a => a.messages).find(m => m.id === id);
const context = async (activation, participant) => fs.readFile(path.join(report, 'evidence/final/contexts', activation, participant, 'context.jsonl'), 'utf8');
const allDispatches = acts.flatMap(a => a.dispatches.map(d => ({ ...d, activationId: a.id })));
const noDispatch = id => !allDispatches.some(d => d.messageIds.includes(id));
const deletedId = '211b863a-a3c3-4574-8151-bb68fc7bd5cb';
const reviewContext = await context(main.id, 'c9445a4d-ae0a-42b9-9d51-d915dbd16c5c');
check('queued member deletion never dispatched or persisted in recipient context', findMessage(deletedId)?.status === 'deleted' && noDispatch(deletedId) && !reviewContext.includes('DELETE_BEFORE_SEND_58'), { messageId: deletedId });
const batchIds = ['423331df-873c-49a3-9cfa-3d29f54297db', '16e37011-a1b8-48b2-b9b3-0941d2f41b82'];
const batch = main.dispatches.find(d => batchIds.every(id => d.messageIds.includes(id)));
check('two busy recipient messages in one actual dispatch and original turn', batch?.turnId === '69ba88d0-f1db-4a37-91a8-9b7fcf82dc78', batch);
const expired = ['b77d436a-59b6-4dba-857b-e0221733b406', '282a1a22-5c16-458c-b1bd-2d556b6c7a2e', '129b4830-02d4-4350-949d-a8b6a5e5a5c1', '4719542b-ebbf-4250-9031-60b51e87a44c'];
for (const id of expired) check('invalidated message has no dispatch', findMessage(id)?.status === 'invalidated' && noDispatch(id), { id, status: findMessage(id)?.status });
for (const id of ['24443a47-eb11-474e-b66e-2c3d4e89e88f', 'e29655c9-8a9e-40b6-9c9e-4b3161dcd1d0']) {
  const m = findMessage(id);
  check('direct teammate message actually consumed', m?.status === 'consumed' && allDispatches.some(d => d.messageIds.includes(id) && d.participantId === m.recipientId), { id, senderId: m?.senderId, recipientId: m?.recipientId, turnId: m?.turnId });
}
const overlaps = [];
for (const a of acts) for (const p of a.participants) {
  const turns = a.turns.filter(t => t.participantId === p.id).sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  for (let i = 1; i < turns.length; i++) if (turns[i - 1].endedAt && turns[i].startedAt < turns[i - 1].endedAt) overlaps.push({ activation: a.id, participant: p.id, previous: turns[i - 1].turnId, next: turns[i].turnId });
}
check('recorded turns have no per-member overlap', overlaps.length === 0, overlaps);
const gateA = main.turns.find(t => t.turnId === '69ba88d0-f1db-4a37-91a8-9b7fcf82dc78');
const gateB = main.turns.find(t => t.turnId === '4d901183-9d78-41fa-957e-8ad28c125434');
check('two gate member turns overlap', gateA.startedAt < gateB.endedAt && gateB.startedAt < gateA.endedAt, [gateA, gateB].map(t => ({ id: t.turnId, started: t.startedAt, ended: t.endedAt })));
const testerContext = await context(business.id, '12e0d7ec-07ff-4324-a1d3-04ebd5808a7f');
const newReview = await context('93f30c0e-1df9-4ac4-ad36-5ab970abed8a', '0cfc02bc-b099-42ff-97e7-db3c1ca49292');
check('other member and other chat lack full private review marker', !testerContext.includes('REVIEW_PRIVATE_8b43') && !newReview.includes('REVIEW_PRIVATE_8b43'), { testerContext: true, newChatContext: true });
const inputRoot = 'web:s_a641935c-a806-4e9e-baa9-8ebc204c5b79';
const transcript = (await fs.readFile(path.join(report, 'evidence/final', `${inputRoot}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const lostId = 'ea5bbfbd-5e8b-4470-9704-c250e4a227c9';
const lostActivation = acts.find(a => a.sessionKey === inputRoot);
check('real accepted response loss executes once', transcript.filter(e => e.type === 'accepted_input' && e.turnId === lostId).length === 1 && lostActivation.turns.filter(t => t.turnId === lostId).length === 1 && lostActivation.dispatches.filter(d => d.turnId === lostId).length === 1, { runId: lostId, turn: lostActivation.turns.find(t => t.turnId === lostId) });
const files = ['out/case15-forbidden-bridge.txt', 'out/case14-cross-A.txt', 'out/case19-leader-hold.txt', 'out/case19-permission.txt', 'out/case19-plan.txt', 'out/case20-permission.txt', 'out/case20-plan.txt', 'out/case14-sametab-A.txt', 'out/case14-sametab-B.txt', 'out/case05-active-delete.txt'];
for (const file of files) check('denied or interrupted file does not exist', !(await fs.stat(path.join('/Users/gucc1/Codes/team-mode-acceptance/release-app', file)).catch(() => null)), file);
for (const [id, expected] of [['973aa73c-f25e-4921-b31e-66854d059a23', 'cancelled'], ['8f3028a3-de97-4dd1-90fd-b55d7e0cd8c4', 'cancelled'], ['47572c0b-5f53-4b84-856a-896456e886ec', 'expired'], ['17bf5475-7a21-4ccc-8997-1857e1e99b12', 'expired']]) {
  const item = main.interactions.find(i => i.id === id);
  check('Abort or restart resolves the real pending interaction', item?.status === expected, { id, expected, actual: item?.status });
}
const deniedA = JSON.parse(await fs.readFile(path.join(report, 'evidence/case14-sametab-a-denied/team-runtime.json'), 'utf8')).state.activations[main.id];
const otherPending = JSON.parse(await fs.readFile(path.join(report, 'evidence/case14-sametab-a-denied/team-runtime.json'), 'utf8')).state.activations['61d1e033-b545-4906-bfdd-f0f047d4c328'];
check('same-tab denial of A leaves B running', deniedA.interactions.find(i => i.id === '48bd7f47-74b0-4bae-9750-1e4e2f1a3db8')?.status === 'denied' && !otherPending.turns.find(t => t.turnId === '8ceb7bce-c2b6-46d4-9e08-86145f84c63d')?.endedAt);
const removed = ['ef9ee930-0a7c-4524-b200-1d169756bc0d', '8c6f39e0-6410-4505-833f-5131faadee63', '8ef95834-ed57-4a19-8f5f-394b5682f9fc'];
check('deleted test configuration identities remain absent', !library.profiles['b7f21a63-9f69-4610-8bb6-28e1bff17c07'] && removed.every(id => !library.teams[id]));
const deletedRun = acts.find(a => a.id === '61d1e033-b545-4906-bfdd-f0f047d4c328');
check('deleted Team execution defect has an actual dispatch', !library.teams[deletedRun.team.id] && deletedRun.dispatches.some(d => d.turnId === '84e05e13-5a99-44b7-9332-99e3b1a54bd0' && d.dispatchedAt), { kind: 'confirmed product defect, not a passed requirement', teamId: deletedRun.team.id, turnId: '84e05e13-5a99-44b7-9332-99e3b1a54bd0' });
check('cross-session denied B file absent', !(await fs.stat('/Users/gucc1/Codes/team-mode-acceptance/release-docs/out/case14-cross-B.txt').catch(() => null)));
check('approved Plan produced intended file', (await fs.readFile('/Users/gucc1/Codes/team-mode-acceptance/release-app/out/case14-plan-fresh.txt', 'utf8')).trim() === 'PLAN_FRESH_52');
const baseline = '/Users/gucc1/Codes/team-mode-acceptance/baselines';
async function walk(dir) { const result = []; for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) result.push(...await walk(file)); else result.push(file); } return result; }
for (const project of ['release-app', 'release-docs']) for (const source of await walk(path.join(baseline, project))) {
  const relative = path.relative(path.join(baseline, project), source);
  check('fixture baseline unchanged', (await fs.readFile(source)).equals(await fs.readFile(path.join('/Users/gucc1/Codes/team-mode-acceptance', project, relative))), `${project}/${relative}`);
}
await fs.mkdir(path.join(report, 'requests'), { recursive: true });
const requestManifest = [];
for (const name of (await fs.readdir(os.tmpdir())).filter(n => /^pilotdeck_request_\d+\.json$/.test(n))) {
  const raw = await fs.readFile(path.join(os.tmpdir(), name), 'utf8');
  const request = JSON.parse(raw);
  if (!request.tools?.some(t => t.function?.name === 'team_send_message')) continue;
  const names = request.tools.map(t => t.function?.name);
  const denied = names.filter(n => ['team_delegate', 'team_followup', 'team_collect', 'team_relay_message', 'team_wait_for_information', 'agent'].includes(n) || /^task_|always_on/.test(n));
  const sensitive = /(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN .*PRIVATE KEY-----)/.test(raw);
  if (sensitive) throw new Error(`Sensitive material in request ${name}`);
  await fs.writeFile(path.join(report, 'requests', name), raw);
  requestManifest.push({ name, model: request.model, sha256: createHash('sha256').update(raw).digest('hex'), tools: names, legacyTools: denied, hiddenMcp: names.some(n => n.includes('qa-hidden')), privateSkillMarker: raw.includes('PRIVATE_CHECKLIST_HIDDEN_19'), idleSame: raw.includes('CASE16_IDLE_SAME'), systemOldPrompt: request.messages?.some(m => m.role === 'system' && JSON.stringify(m.content).includes('CONFIG_UPDATED_64')), systemNewPrompt: request.messages?.some(m => m.role === 'system' && JSON.stringify(m.content).includes('CONFIG_IDLE_NEW_91')) });
}
check('observed actual Team tool schemas exclude old tools and hidden MCP tools', requestManifest.every(r => !r.legacyTools.length && !r.hiddenMcp && !r.privateSkillMarker), { count: requestManifest.length });
const stale = requestManifest.filter(r => r.idleSame);
check('stale Leader system prompt reproduced in actual request', stale.length > 0 && stale.every(r => r.systemOldPrompt && !r.systemNewPrompt), stale);
const toolDescriptions = requestManifest.map(r => r.name);
const descriptions = [];
for (const name of toolDescriptions) {
  const request = JSON.parse(await fs.readFile(path.join(report, 'requests', name), 'utf8'));
  const description = request.tools.find(t => t.function?.name === 'team_send_message').function.description;
  if (!descriptions.includes(description)) descriptions.push(description);
}
check('Leader and Teammate observed descriptions differ', descriptions.length >= 2, descriptions);
for (const name of ['qa-allowed', 'qa-hidden']) await fs.copyFile(path.join(home, 'team-mode-test/mcp-logs', `${name}.jsonl`), path.join(report, `${name}.jsonl`));
const hiddenConnections = (await fs.readFile(path.join(report, 'qa-hidden.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
rows.push({ name: 'unattributed hidden MCP connection; cannot assert zero', passed: null, detail: hiddenConnections });
const active = acts.flatMap(a => a.turns.filter(t => !t.endedAt).map(t => ({ activation: a.id, turn: t.turnId })));
const pending = acts.flatMap(a => a.interactions.filter(i => i.status === 'pending').map(i => i.id));
const queued = acts.flatMap(a => a.messages.filter(m => ['queued', 'preparing', 'sending'].includes(m.status)).map(m => m.id));
check('acceptance leaves no running turns or pending internal work', !active.length && !pending.length && !queued.length, { active, pending, queued });
check('independent role and Team saves retain B', library.profiles['62da9fe7-412d-4625-9c22-de03a639fd91'].config.description === 'CASE02_ROLE_B_72' && library.teams['341737c0-24e3-4e3a-9935-216e0d32b110'].config.description === 'CASE02_INDEPENDENT_TEAM_B_94');
await fs.writeFile(path.join(report, 'request-manifest.json'), JSON.stringify(requestManifest, null, 2));
await fs.writeFile(path.join(report, 'evidence-audit.json'), JSON.stringify({ at: new Date().toISOString(), kind: 'persistent evidence audit, not a replacement for browser E2E', rows }, null, 2));
console.log(JSON.stringify({ checks: rows.length, failed: rows.filter(r => r.passed === false), uncertain: rows.filter(r => r.passed === null), requests: requestManifest.length }, null, 2));
