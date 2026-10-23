/** Real HTTP/WS/browser QA with deterministic model output; no external model service. */
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { createModelRuntime, type CanonicalModelRequest, type CanonicalModelEvent } from '../../src/model/index.js';
import { createProjectId } from '../../src/pilot/index.js';
import type { AgentProfile, ProfileConfig, TeamDefinition } from '../../src/team/types.js';

const base = process.env.PILOTDECK_TEAM_FIXTURE;
if (!base || !/^\/(private\/)?tmp\//.test(resolve(base))) throw new Error('Use a disposable PILOTDECK_TEAM_FIXTURE under /tmp.');
const home = join(base, 'home'), workspace = join(base, 'workspaces', 'Release review');
await mkdir(join(home, 'skills'), { recursive: true }); await mkdir(workspace, { recursive: true });
const stored = join(home, 'projects', createProjectId(workspace));
await mkdir(stored, { recursive: true }); await writeFile(join(stored, '.cwd'), workspace);
await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent: { model: test/default, maxContextTokens: 32768, maxOutputTokens: 4096 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture-only
      models: { default: {}, leader: {}, reviewer: {}, tester: {} }
router: { enabled: false }
webui:
  runtime:
    workspacesRoot: ${JSON.stringify(join(base, 'workspaces'))}
    databasePath: ${JSON.stringify(join(home, 'auth.db'))}
`);
let team: TeamDefinition;
function* call(name: string, input: unknown): Generator<CanonicalModelEvent> {
  const id = randomUUID();
  yield { type: 'tool_call_start', id, name };
  yield { type: 'tool_call_end', toolCall: { id, name, input } };
}
function outputs(request: CanonicalModelRequest, name: string): unknown[] {
  const blocks = request.messages.flatMap(message => message.content);
  const ids = new Set(blocks.filter(block => block.type === 'tool_call' && block.name === name).map(block => block.type === 'tool_call' ? block.id : ''));
  return blocks.filter(block => block.type === 'tool_result' && ids.has(block.toolCallId)).flatMap(block => {
    if (block.type !== 'tool_result') return [];
    return block.content.flatMap(part => { if (part.type !== 'text') return []; try { return [JSON.parse(part.text)]; } catch { return []; } });
  });
}
const local = createLocalGateway({
  pilotHome: home, projectRoot: workspace, fallbackProjectRoot: home, builtinSkillsRoot: join(home, 'skills'),
  env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
  __testModelFactory: snapshot => ({
    ...createModelRuntime(snapshot.config.model),
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      await appendFile(join(base, 'model-requests.jsonl'), JSON.stringify({ model: request.model, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools?.map(tool => tool.name) }) + '\n');
      yield { type: 'request_started', provider: request.provider, model: request.model };
      yield { type: 'message_start', role: 'assistant' };
      const called = (name: string) => request.messages.some(message => message.content.some(block => block.type === 'tool_call' && block.name === name));
      if (request.model === 'leader') {
        if (!called('team_delegate')) {
          yield* call('team_delegate', { participantId: team.teammates[0].id, task: 'Review the release configuration.', requestToken: 'qa-review' });
          yield* call('team_delegate', { participantId: team.teammates[1].id, task: 'Test the release and ask the reviewer about configuration.', requestToken: 'qa-test' });
          yield { type: 'message_end', finishReason: 'tool_call' }; return;
        }
        let state;
        try { state = JSON.parse(await readFile(join(home, 'team-runtime', 'state.json'), 'utf8')).state; } catch { state = { activations: {} }; }
        const activation = Object.values(state.activations).find((value: any) => value.status === 'active') as any;
        const mediated = activation?.messages.find((message: any) => message.recipientId !== message.intendedRecipientId && !activation.messages.some((item: any) => item.relayOf === message.id));
        if (mediated) {
          yield* call('team_relay_message', { messageId: mediated.id, requestToken: 'qa-relay' });
          yield { type: 'message_end', finishReason: 'tool_call' }; return;
        }
        const collected = outputs(request, 'team_collect') as any[];
        const next = activation?.works.find((work: any) => work.status === 'completed' && !collected.some(result => result.id === work.id));
        if (next) { yield* call('team_collect', { workId: next.id }); yield { type: 'message_end', finishReason: 'tool_call' }; return; }
        yield { type: 'text_delta', text: activation?.works.length === 2 && activation.works.every((work: any) => work.status === 'completed') ? 'Release review complete. The reviewer and tester finished; configuration was confirmed through Leader mediation.' : 'The team is reviewing the release. I will collect both results.' };
      } else if (request.model === 'tester') {
        if (!called('team_send_message')) {
          yield* call('team_send_message', { recipientId: team.teammates[0].id, text: 'Please confirm the release configuration.', requestToken: 'qa-peer' });
          yield { type: 'message_end', finishReason: 'tool_call' }; return;
        }
        yield { type: 'text_delta', text: 'Release tests passed. Configuration question sent via Leader.' };
      } else if (request.model === 'reviewer') {
        yield { type: 'text_delta', text: 'The release configuration is valid. Code review passed.' };
      } else yield { type: 'text_delta', text: 'Ordinary conversation response.' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'message_end', finishReason: 'stop' };
    },
    async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Release review' }], finishReason: 'stop' as const }; },
  }),
});
const config = (displayName: string, model: string): ProfileConfig => ({ displayName, description: '', systemPrompt: `You are ${displayName}. Work carefully and return evidence.`, model: { mode: 'model', provider: 'test', model }, workspace: { mode: 'team' }, capabilities: { tools: [], skills: [], mcpServers: [] }, optionalCapabilities: [], permissionMode: 'default' });
const library = await local.gateway.teamCommand!({ action: 'library' });
if ('teams' in library && library.teams.length) team = library.teams[0];
else {
  const leader = await local.gateway.teamCommand!({ action: 'profile_save', role: 'leader', config: config('Release lead', 'leader'), requestToken: 'qa-leader' }) as AgentProfile;
  const teammates = await Promise.all(['reviewer', 'tester'].map(model => local.gateway.teamCommand!({ action: 'profile_save', role: 'teammate', config: config(model === 'reviewer' ? 'Code reviewer' : 'Release tester', model), requestToken: `qa-${model}` }) as Promise<AgentProfile>));
  team = await local.gateway.teamCommand!({ action: 'team_save', requestToken: 'qa-team', config: { displayName: 'Release review team', description: 'Release review with two specialists.', instructions: 'Review the release with both specialists.', defaultProjectKey: workspace, leader: { id: leader.id, revision: leader.revision }, teammates: teammates.map(({ id, revision }) => ({ id, revision })) } }) as TeamDefinition;
}
const token = 'team-runtime-fixture-only'; await writeFile(join(home, 'server-token'), token, { mode: 0o600 });
const server = await startGatewayServer({ gateway: local.gateway, token, host: '127.0.0.1', port: Number(process.env.PILOTDECK_TEAM_GATEWAY_PORT || 18974) });
local.bindServer(server);
await writeFile(join(base, 'fixture.json'), JSON.stringify({ home, projects: [workspace], team, gatewayUrl: server.wsUrl }));
console.log(`Team runtime fixture ready ${server.wsUrl} (${base})`);
const stop = async () => { await local.dispose(); await server.close(); process.exit(0); };
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
