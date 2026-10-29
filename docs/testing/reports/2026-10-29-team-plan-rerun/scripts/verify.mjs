import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const report = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(readFileSync(resolve(report, 'evidence', name), 'utf8'));
const save = (name, data) => writeFileSync(resolve(report, 'evidence', name), JSON.stringify(data, null, 2) + '\n');
const setup = read('setup.json');
const pending = read('pending.json');
const leaderPending = read('leader-plan-pending.json');
const final = read('final-after-refresh.json');
const activation = final.runtime.activation;
const blocks = transcript => transcript.messages.flatMap(message => (message.content ?? []).map(block => ({ message, block })));
const members = final.transcripts.map(transcript => ({
  participantId: transcript.id,
  displayName: transcript.name,
  tools: blocks(transcript).filter(({ block }) => ['tool_call', 'tool_result'].includes(block.type)).map(({ message, block }) => ({
    messageId: message.id, turnId: message.turnId, createdAt: message.createdAt,
    type: block.type, toolCallId: block.id ?? block.toolCallId,
    toolName: block.name ?? block.raw?.toolName,
    input: block.type === 'tool_call' ? block.input : undefined,
    resultType: block.raw?.type,
    resultText: block.type === 'tool_result' ? block.content?.map(part => part.text ?? '').join('\n') : undefined,
    returnedModel: block.type === 'tool_call' ? block.raw?.model : undefined,
  })),
}));
const leaderTools = final.history.messages.filter(message => ['tool_use', 'tool_result'].includes(message.kind)).map(message => ({
  messageId: message.id, turnId: message.turnId, createdAt: message.createdAt,
  type: message.kind, toolCallId: message.toolCallId, toolName: message.toolName,
  input: message.kind === 'tool_use' ? message.payload : undefined,
  ok: message.ok, resultText: message.kind === 'tool_result' ? message.text : undefined,
}));
const events = leaderPending.snapshot.events.filter(event => event.type === 'tool_call_finished').map(event => ({
  toolCallId: event.toolCallId, toolName: event.toolName, ok: event.ok,
  errorCode: event.errorCode, runId: event.runId, resultPreview: event.resultPreview,
}));
save('tool-evidence.json', { leader: leaderTools, members, leaderPlanPendingResults: events });

const planFiles = ['reviewer', 'tester', 'leader'].map(role => {
  const path = `.pilotdeck/plans/qa1029-${role}.md`;
  return { path, content: readFileSync(resolve(setup.project, path), 'utf8') };
});
save('plan-files.json', planFiles);
const baseline = read('baseline.json');
const hashes = baseline.files.map(file => {
  const current = createHash('sha256').update(readFileSync(file.path)).digest('hex');
  return { ...file, current, unchanged: current === file.sha256 };
});
const reviewer = members.find(member => member.displayName.endsWith('reviewer'));
const tester = members.find(member => member.displayName.endsWith('tester'));
const call = (member, name) => member.tools.filter(tool => tool.type === 'tool_call' && tool.toolName === name);
const result = (member, name) => member.tools.find(tool => tool.type === 'tool_result' && tool.toolName === name);
const file = name => final.files.find(entry => entry.path === `out/QA1029-${name}.txt`);
const checks = {
  twoRealMemberPlanEntries: members.every(member => call(member, 'enter_plan_mode').length === 1 && result(member, 'enter_plan_mode')?.resultText.includes('Plan mode activated.')),
  memberPlansPendingTogether: pending.runtime.activation.interactions.filter(entry => entry.kind === 'plan_approval' && entry.status === 'pending').length === 2,
  leaderIdleWhileMemberPlansPending: pending.snapshot.active === false,
  noMemberExitPlanInLeaderTranscript: !pending.history.messages.some(message => message.toolName === 'exit_plan_mode'),
  reviewerApproved: activation.interactions.some(entry => entry.participantDisplayName.endsWith('reviewer') && entry.kind === 'plan_approval' && entry.status === 'approved'),
  testerDeclinedWithFeedback: activation.interactions.some(entry => entry.participantDisplayName.endsWith('tester') && entry.status === 'declined' && JSON.stringify(entry.resolution).includes('QA1029_DECLINE_NOTE')),
  reviewerActuallyReceivedApproval: result(reviewer, 'exit_plan_mode')?.resultText.includes('User has approved your plan.'),
  testerActuallyReceivedFeedback: result(tester, 'exit_plan_mode')?.resultText.includes('QA1029_DECLINE_NOTE'),
  reviewerMarkerWritten: file('reviewer-approved')?.content === 'QA1029_REVIEWER_EXECUTED',
  testerNoMarkerOrResubmit: file('tester-declined')?.exists === false && call(tester, 'exit_plan_mode').length === 1 && call(tester, 'write_file').length === 1,
  independentReviewerWritePermission: activation.interactions.some(entry => entry.participantDisplayName.endsWith('reviewer') && entry.kind === 'tool_permission' && entry.status === 'allowed'),
  leaderReallyEnteredPlan: events.some(event => event.toolName === 'enter_plan_mode' && event.ok === true),
  planInspectAndCollectSucceed: ['team_inspect', 'team_collect'].every(name => events.some(event => event.toolName === name && event.ok === true)),
  planDelegateAndSendBlocked: ['team_delegate', 'team_send_message'].every(name => events.some(event => event.toolName === name && event.ok === false && event.errorCode === 'plan_mode_violation')),
  leaderReceivedApproval: leaderTools.some(tool => tool.type === 'tool_result' && tool.toolName === 'exit_plan_mode' && tool.ok && tool.resultText.includes('User has approved your plan.')),
  leaderMarkerWritten: file('leader-approved')?.content === 'QA1029_LEADER_EXECUTED',
  noExtraWorkOrMessage: activation.works.length === 2 && activation.messages.length === 0,
  finalIdleAndNoPending: final.snapshot.active === false && final.transcripts.every(transcript => !transcript.streaming) && activation.works.every(work => work.status === 'completed') && activation.interactions.every(entry => entry.status !== 'pending'),
  sourceAndBuildHashesUnchanged: hashes.every(file => file.unchanged),
};
save('verification.json', {
  at: new Date().toISOString(), sessionKey: activation.sessionKey, activationId: activation.id, stopVersion: activation.stopVersion,
  checks, allPassed: Object.values(checks).every(Boolean), hashes,
  interactions: activation.interactions, files: final.files,
  limits: 'Programmatic evidence audit only; visual behavior is evidenced by Computer Use screenshots and AX records. No Gateway restart, deliberate disconnect, mobile/theme matrix, or Leader decline was tested.',
});
console.log(JSON.stringify({ checks, allPassed: Object.values(checks).every(Boolean) }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
