import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputQueueState } from '../chat/types/queuedInput';
import QueuedMessagesTray from './QueuedMessagesTray';
import { getQueueMenuPosition } from './queueMenuPosition';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

afterEach(cleanup);

const item = (id: string, displayText: string) => ({
  id,
  displayText,
  createdAt: '2026-08-26T00:00:00.000Z',
  status: 'queued' as const,
  attachmentCount: 0,
});

function renderTray(state: InputQueueState) {
  return render(
    <QueuedMessagesTray
      state={state}
      isLoading
      onResume={vi.fn()}
      onSteer={vi.fn()}
      onDelete={vi.fn()}
      onMoveToFront={vi.fn()}
    />,
  );
}

describe('QueuedMessagesTray overflow menu', () => {
  it('does not show a meaningless more menu when the queue has one item', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: false,
      items: [item('one', 'Only item')],
    });

    expect(screen.queryByRole('button', { name: 'More queue actions' })).toBeNull();
  });

  it('portals the move-to-front menu outside the scroll region for later items', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: false,
      items: [item('one', 'First item'), item('two', 'Second item')],
    });

    const moreButton = screen.getByRole('button', { name: 'More queue actions' });
    fireEvent.click(moreButton);

    const menu = screen.getByRole('menu', { name: 'More queue actions' });
    expect(screen.getByTestId('queue-scroll-region').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect((screen.getByRole('menuitem', { name: 'Move to front' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns before retrying a delivery whose restart status is uncertain', () => {
    renderTray({
      sessionId: 'web:s_test',
      revision: 1,
      paused: true,
      pauseReason: 'restart_recovery',
      items: [{ ...item('one', 'Maybe sent'), status: 'delivery_uncertain' }],
    });

    expect(screen.getByText('A message may already have been sent before restart. Retry only if needed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByLabelText('Delivery status uncertain')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Adjust direction' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('getQueueMenuPosition', () => {
  it('opens above the trigger when there is enough space', () => {
    expect(getQueueMenuPosition({
      anchor: { top: 200, right: 300, bottom: 230 },
      viewportWidth: 500,
      viewportHeight: 500,
    })).toEqual({ left: 156, top: 150, placement: 'top' });
  });

  it('opens below the trigger near the top edge and stays inside the viewport', () => {
    expect(getQueueMenuPosition({
      anchor: { top: 20, right: 100, bottom: 50 },
      viewportWidth: 120,
      viewportHeight: 100,
    })).toEqual({ left: 8, top: 48, placement: 'bottom' });
  });
});


it('shows only waiting messages while submission and dispatch appear in the conversation', () => {
  const state: InputQueueState = { sessionId: 'web:s_send', revision: 1, paused: false, items: [
    { ...item('sending', 'Sending now'), status: 'submitting' },
    item('waiting', 'Waiting for the active turn'),
  ] };
  const view = renderTray(state);
  expect(screen.queryByText('Sending now')).toBeNull();
  expect(screen.getByText('Waiting for the active turn')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'More queue actions' })).toBeNull();
  view.rerender(<QueuedMessagesTray state={{ ...state, items: [{ ...item('sending', 'Sending now'), status: 'dispatching' }] }} isLoading={false} onResume={vi.fn()} onSteer={vi.fn()} onDelete={vi.fn()} onMoveToFront={vi.fn()} />);
  expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull();
});

it('hides invalidated inputs without a history or recovery board', () => {
  renderTray({ sessionId: 'team', revision: 5, paused: true, items: [{ ...item('expired', 'Preserved input'), status: 'invalidated' }] });
  expect(screen.queryByText('Preserved input')).toBeNull();
  expect(screen.queryByRole('region')).toBeNull();
});

it('shows whether user input joins the next model request or becomes the next user message', () => {
  const state: InputQueueState = { sessionId: 'team', revision: 1, paused: false, items: [item('one', 'User request')] };
  const onSteer = vi.fn();
  const props = { state, isLoading: true, onResume: vi.fn(), onSteer, onDelete: vi.fn(), onMoveToFront: vi.fn() };
  const view = render(<QueuedMessagesTray {...props}/>);
  expect(screen.getByText('Treated as the next user message')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Adjust direction' }));
  expect(onSteer).toHaveBeenCalledWith('one');
  view.rerender(<QueuedMessagesTray {...props} state={{ ...state, revision: 2, items: [{ ...state.items[0], status: 'steering' }] }}/>);
  expect(screen.getByText('Handled at the next model request')).toBeTruthy();
  expect(screen.queryByText('Treated as the next user message')).toBeNull();
});

const memberMessage = (id: string, overrides = {}) => ({
  id, senderId: 'worker', recipientId: 'leader', intendedRecipientId: 'leader', text: `Full content of ${id}`,
  kind: 'member', status: 'queued', stopVersion: 2, createdAt: '2026-11-02T00:00:00Z', ...overrides,
});
const activation = (messages: ReturnType<typeof memberMessage>[], overrides = {}) => ({
  id: 'activation', stopVersion: 2, status: 'active', messages,
  participants: [
    { id: 'leader', role: 'leader', profile: { config: { displayName: 'Leader name' } } },
    { id: 'worker', role: 'teammate', profile: { config: { displayName: 'Reviewer' } } },
  ], ...overrides,
} as any);
const emptyState: InputQueueState = { sessionId: 'team', revision: 1, paused: false, items: [] };
const actions = () => ({ onResume: vi.fn(), onSteer: vi.fn(), onDelete: vi.fn(), onMoveToFront: vi.fn() });

it('shows only the source and handling state of pending Leader messages until expanded', () => {
  const teamActivation = activation([
    memberMessage('member'), memberMessage('system', { senderId: 'system', kind: 'turn_ended', status: 'preparing' }),
    ...['consumed', 'invalidated', 'deleted', 'sending', 'uncertain', 'legacy_unknown', 'delivered', 'interrupted', 'stopped'].map(status => memberMessage(status, { status })),
    memberMessage('other-recipient', { recipientId: 'worker' }), memberMessage('old-run', { stopVersion: 1 }),
  ]);
  const props = { state: emptyState, isLoading: true, teamActivation, onDeleteTeamMessage: vi.fn(), ...actions() };
  const view = render(<QueuedMessagesTray {...props}/>);
  expect(screen.getByText('Teammate · Reviewer')).toBeTruthy();
  expect(screen.getByText('System notification')).toBeTruthy();
  expect(screen.getAllByText('Handled at the next model request')).toHaveLength(2);
  expect(screen.queryByText(/Full content/)).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Delete queued message' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Adjust direction' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Teammate · Reviewer/ }));
  expect(screen.getByText('Full content of member')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /System notification/ }));
  expect(screen.getByText('Full content of system')).toBeTruthy();
  view.rerender(<QueuedMessagesTray {...props} teamActivation={activation(teamActivation.messages.map((message: any) => ({ ...message, status: 'consumed' })))}/>);
  expect(screen.queryByRole('region')).toBeNull();
});

it('keeps user input controls and Team message deletion separate and reports a deletion race', async () => {
  const message = memberMessage('member');
  const onDeleteTeamMessage = vi.fn().mockRejectedValue(new Error('Already sent to the model'));
  const onDelete = vi.fn();
  render(<QueuedMessagesTray state={{ ...emptyState, items: [item('user', 'User request')] }} isLoading
    {...actions()} onDelete={onDelete} teamActivation={activation([message])} onDeleteTeamMessage={onDeleteTeamMessage}/>);
  const buttons = screen.getAllByRole('button', { name: 'Delete queued message' });
  fireEvent.click(buttons[0]); expect(onDelete).toHaveBeenCalledWith('user');
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Already sent to the model'));
  expect(onDeleteTeamMessage).toHaveBeenCalledWith(message);
  expect(screen.getByText('Teammate · Reviewer')).toBeTruthy();
});

it('removes Team messages when the Team stops or advances to a different run', () => {
  const props = { state: emptyState, isLoading: false, ...actions() };
  const view = render(<QueuedMessagesTray {...props} teamActivation={activation([memberMessage('member')])}/>);
  expect(screen.getByRole('region')).toBeTruthy();
  view.rerender(<QueuedMessagesTray {...props} teamActivation={activation([memberMessage('member')], { status: 'stopping' })}/>);
  expect(screen.queryByRole('region')).toBeNull();
  view.rerender(<QueuedMessagesTray {...props} teamActivation={activation([memberMessage('member')], { stopVersion: 3 })}/>);
  expect(screen.queryByRole('region')).toBeNull();
});
