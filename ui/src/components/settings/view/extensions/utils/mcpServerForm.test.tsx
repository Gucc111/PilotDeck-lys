import { expect, it } from 'vitest';
import { formFromRaw, parseServers, stringifyServers } from './mcpServerForm';

it('editing connection strategy preserves cwd, timeouts, credentials and plugin fields', () => {
  const raw = {
    command: 'node', args: ['server.mjs'], cwd: '/workspace/project',
    env: { TOKEN: '${env:TOKEN}', MODE: 'test' }, perSession: true,
    connectTimeoutMs: 1234, callTimeoutMs: 5678, concurrencySafe: false,
    vendorSettings: { profile: 'project', nested: [1, 2] },
  };
  const form = formFromRaw('browser', raw);
  form.connection = 'shared'; form.usage = 'serial'; form.maxConnections = '5';
  const result = JSON.parse(stringifyServers([form])).mcpServers.browser;
  expect(result).toEqual({ ...raw, connection: 'shared', usage: 'serial' });
  expect(raw).not.toHaveProperty('connection');
});

it('separate mode serializes the connection limit and HTTP custom fields round trip', () => {
  const raw = { httpUrl: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' }, cwd: '/work', custom: { retries: 2 } };
  const form = formFromRaw('remote', raw);
  form.maxConnections = '3';
  const serialized = stringifyServers([form]);
  expect(JSON.parse(serialized).mcpServers.remote).toEqual({
    url: raw.httpUrl, headers: raw.headers, cwd: raw.cwd, custom: raw.custom,
    connection: 'separate', usage: 'concurrent', maxConnections: 3,
  });
  expect(stringifyServers(parseServers(serialized).servers)).toBe(serialized);
});
