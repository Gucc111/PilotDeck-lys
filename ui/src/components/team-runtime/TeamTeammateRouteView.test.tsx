// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
import { participantChatMessages } from './participantMessages';
import TeamTeammateRouteView from './TeamTeammateRouteView';

const mock = vi.hoisted(() => ({ command: vi.fn(), sendMessage: vi.fn(), ws: { readyState: 1 }, subscribers: new Set<(event: any) => void>(), subscribe: (fn: (event: any) => void) => { mock.subscribers.add(fn); return () => mock.subscribers.delete(fn); } }));
vi.mock('../team-library/api', () => ({ teamCommand: mock.command }));
vi.mock('../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mock.subscribe, sendMessage: mock.sendMessage, ws: mock.ws }) }));
// Render the projected messages to observe streaming/reconciliation separately
// from the already-covered shared renderer, which is exercised in the browser.
vi.mock('../chat-v2/SubagentDetailMessageFlow', () => ({ default: ({ messages }: any) => <div data-testid="readonly-flow">{messages.map((message: any) => <p key={message.id}>{message.content}</p>)}</div> }));
const member = { id: 'mate', role: 'teammate', profile: { config: { displayName: 'Researcher' } } };
const activation = { id: 'act', sessionKey: 'root', stopVersion: 0, participants: [member] };
const block = (text: string, isStreaming = false) => ({ id: 'turn:block', turnId: 'turn', role: 'assistant', createdAt: '2026-10-28T00:00:00Z', content: [{ type: 'text', text, blockId: 'block' }], isStreaming });
const page = (messages = [block('Saved')], extra: any = {}) => ({ sessionKey: 'root', activationId: 'act', participantId: 'mate', stopVersion: 0, streamEpoch: 'server', revision: 1, messages, streaming: false, ...extra });
const emit = (extra: any = {}) => { for (const subscriber of mock.subscribers) subscriber({ type: 'team-participant-message', sessionId: 'root', activationId: 'act', participantId: 'mate', stopVersion: 0, streamEpoch: 'server', revision: 2, streaming: true, messages: [block('Live partial', true)], ...extra }); };
async function mount() {
  const i18n = await createTestI18n();
  return render(<I18nextProvider i18n={i18n}><MemoryRouter initialEntries={['/team/root/act/teammate/mate']}><Routes><Route path="/team/:rootSessionKey/:activationId/teammate/:participantId" element={<TeamTeammateRouteView/>}/><Route path="/session/:id" element={<div>Root conversation</div>}/></Routes></MemoryRouter></I18nextProvider>);
}
beforeEach(() => { mock.command.mockReset(); mock.command.mockImplementation(async (input: any) => input.action === 'runtime_get' ? { activation } : page()); });
afterEach(() => { cleanup(); mock.subscribers.clear(); });

describe('read-only Teammate route', () => {
  it('restores a direct URL, applies streaming upserts without fetching per delta, ignores other owners, and returns to root', async () => {
    await mount();
    await screen.findByText('Saved');
    expect(mock.sendMessage).toHaveBeenCalledWith({ type: 'watch-session', sessionId: 'root' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /send|stop|model/i })).toBeNull();
    const calls = mock.command.mock.calls.length;
    act(() => emit());
    await screen.findByText('Live partial');
    expect(screen.queryByText('Saved')).toBeNull();
    expect(mock.command.mock.calls.length).toBe(calls);
    act(() => { emit({ revision: 3, participantId: 'other', messages: [block('Wrong member')] }); emit({ revision: 3, stopVersion: 99, messages: [block('Wrong generation')] }); emit({ revision: 3, activationId: 'old', messages: [block('Old Team')] }); emit({ revision: 1, messages: [block('Stale delta')] }); });
    expect(screen.getAllByText('Live partial')).toHaveLength(1);
    expect(screen.queryByText(/Wrong|Old Team|Stale delta/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Team' }));
    expect(screen.getByText('Root conversation')).toBeTruthy();
    expect(mock.sendMessage).toHaveBeenCalledWith({ type: 'unwatch-session', sessionId: 'root' });
  });

  it('retains a newer live block when an earlier reconnect snapshot arrives, then reloads the final durable transcript', async () => {
    await mount(); await screen.findByText('Saved');
    let complete!: (value: any) => void;
    mock.command.mockImplementation(async (input: any) => input.action === 'runtime_get' ? { activation } : new Promise(resolve => { complete = resolve; }));
    act(() => { for (const subscriber of mock.subscribers) subscriber({ type: 'websocket-reconnected' }); });
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    act(() => emit());
    act(() => complete(page()));
    await screen.findByText('Live partial');
    mock.command.mockImplementation(async (input: any) => input.action === 'runtime_get' ? { activation } : page([block('Completed')], { revision: 4 }));
    act(() => emit({ revision: 3, messages: [], streaming: false, reload: true }));
    await screen.findByText('Completed');
    expect(screen.queryByText('Live partial')).toBeNull();
  });

  it('rejects mismatched paginated owner data instead of displaying another members transcript', async () => {
    mock.command.mockImplementation(async (input: any) => input.action === 'runtime_get' ? { activation } : input.cursor ? page([block('Private other')], { participantId: 'other' }) : page([], { nextCursor: '200' }));
    await mount();
    await screen.findByRole('alert');
    expect(screen.queryByText('Private other')).toBeNull();
  });
});

it('projects thinking and attaches tool results to their call without interactive prompt cards', () => {
  const messages = participantChatMessages([
    { id: 'think', role: 'assistant', content: [{ type: 'thinking', text: 'Considering', blockId: 'thinking' }], isStreaming: true },
    { id: 'call', role: 'assistant', content: [{ type: 'tool_call', id: 'tool', name: 'ask_user_question', input: { questions: ['Question'] } }] },
    { id: 'result', role: 'user', content: [{ type: 'tool_result', toolCallId: 'tool', content: [{ type: 'text', text: 'Answered' }], isError: false }] },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages[0].isThinking).toBe(true);
  expect(messages[0].isStreaming).toBe(true);
  expect(messages[1].toolResult?.content).toBe('Answered');
  expect(messages.some(message => message.isInteractivePrompt)).toBe(false);
});

it('shows idle Team batches as user input and busy injections as same-turn markers', () => {
  const metadata = { purpose: 'team_runtime', teamConsumed: true, teamEventIds: ['message'], teamMessages: [{ id: 'message', senderId: 'leader', sender: 'Leader name', text: 'Keep the old API' }] };
  const messages = participantChatMessages([
    { id: 'start', turnId: 'turn', role: 'user', metadata: { ...metadata, teamInjectionMode: 'start' }, text: 'raw provider prompt' },
    { id: 'during', turnId: 'turn', role: 'user', metadata: { ...metadata, teamInjectionMode: 'during' }, text: 'raw provider prompt' },
  ]);
  expect(messages[0]).toMatchObject({ type: 'user', content: 'Leader name: Keep the old API', turnId: 'turn' });
  expect(messages[1]).toMatchObject({ type: 'system', isTeamInjection: true, content: 'Leader name: Keep the old API', turnId: 'turn' });
  expect(messages[1].isTeamBoundary).toBeUndefined();
});
