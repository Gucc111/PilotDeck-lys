/**
 * Isolated real Gateway for browser QA. Model calls are forbidden in configuration-only QA.
 * See ui/e2e/TEAM-LIBRARY.md for the Express/Vite/browser commands.
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { createModelRuntime, type CanonicalModelRequest } from '../../src/model/index.js';
import { createProjectId } from '../../src/pilot/index.js';

const base = process.env.PILOTDECK_TEAM_FIXTURE;
if (!base || !resolve(base).startsWith('/private/tmp/') && !resolve(base).startsWith('/tmp/')) throw new Error('Set PILOTDECK_TEAM_FIXTURE to a disposable directory under /tmp.');
const home = join(base, 'home');
const projects = [join(base, 'workspaces', 'Quarterly report'), join(base, 'workspaces', 'Research library')];
await mkdir(join(home, 'skills'), { recursive: true });
for (const project of projects) {
  await mkdir(project, { recursive: true });
  const stored = join(home, 'projects', createProjectId(project));
  await mkdir(stored, { recursive: true });
  await writeFile(join(stored, '.cwd'), project);
}
await writeFile(join(home, 'pilotdeck.yaml'), `schemaVersion: 1
agent: { model: test/default }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test
      models: { default: {}, leader: {}, researcher: {} }
router: { enabled: false }
webui:
  runtime:
    workspacesRoot: ${JSON.stringify(join(base, 'workspaces'))}
    databasePath: ${JSON.stringify(join(home, 'auth.db'))}
`);
const local = createLocalGateway({
  pilotHome: home, projectRoot: projects[0], fallbackProjectRoot: home, builtinSkillsRoot: join(home, 'skills'),
  env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
  __testModelFactory: snapshot => ({
    ...createModelRuntime(snapshot.config.model),
    async *stream(request: CanonicalModelRequest) {
      await appendFile(join(base, 'model-requests.jsonl'), JSON.stringify({ provider: request.provider, model: request.model, messages: request.messages }) + '\n');
      throw new Error('Configuration management must never call a model.');
    },
    async complete(request: CanonicalModelRequest) {
      await appendFile(join(base, 'model-requests.jsonl'), JSON.stringify({ provider: request.provider, model: request.model }) + '\n');
      throw new Error('Configuration management must never call a model.');
    },
  }),
});
const token = 'team-fixture-only-token';
await writeFile(join(home, 'server-token'), token, { mode: 0o600 });
const server = await startGatewayServer({ gateway: local.gateway, token, host: '127.0.0.1', port: Number(process.env.PILOTDECK_TEAM_GATEWAY_PORT || 18973) });
await writeFile(join(base, 'fixture.json'), JSON.stringify({ home, projects, gatewayUrl: server.wsUrl }));
console.log(`Team fixture ready ${server.wsUrl} (${base})`);
const stop = async () => { local.dispose(); await server.close(); process.exit(0); };
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
