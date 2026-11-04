import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { McpConnectionStatus } from './McpConnectionStatus';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); mocks.fetch.mockReset(); });
const owner = { sessionKey: 'chat' };
const row = { serverId: 'db', resourceId: 'opaque-hash', state: 'waiting_capacity', stage: 'capacity', owner, holders: [{ sessionKey: 'holder' }], busy: true };
function reply(statuses = [row]) { mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ statuses }) }); }
it('initial preparation waits show holder and allow cancellation before the model starts', async () => {
  reply(); render(<McpConnectionStatus sessionKey="chat" />);
  await screen.findByText(/holder/);
  fireEvent.click(screen.getByRole('button', { name: 'mcpConfig.cancelWait' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'POST' && JSON.parse(opts.body).action === 'cancel')).toBe(true));
  expect(JSON.parse(mocks.fetch.mock.calls.find(([, opts]) => opts?.method === 'POST')![1].body).owner).toEqual(owner);
});
it('management disables release while preparing and provides explicit unknown-state reset', async () => {
  reply([{ ...row, state: 'unknown' }]); render(<McpConnectionStatus management />);
  await screen.findByText(/mcpConfig.status.unknown/);
  expect((screen.getByRole('button', { name: 'mcpConfig.release' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'mcpConfig.resetUnknown' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'POST' && JSON.parse(opts.body).resourceId === 'opaque-hash')).toBe(true));
});
it('participant view excludes other activations and participants', async () => {
  reply([{ ...row, owner: { ...owner, activationId: 'old', participantId: 'worker' } } as any]);
  render(<McpConnectionStatus activationId="current" participantId="worker" />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('region')).toBeNull();
});
it('chat shows status-query errors even when no connection rows were received', async () => {
  mocks.fetch.mockRejectedValue(new Error('Gateway unavailable'));
  render(<McpConnectionStatus sessionKey="chat" />);
  expect((await screen.findByRole('alert')).textContent).toContain('Gateway unavailable');
});
