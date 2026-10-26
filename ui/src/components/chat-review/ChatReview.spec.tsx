import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatReviewProvider, type ReviewOpenRequest } from './ChatReviewContext';
import ChatReviewSidePanel from './ChatReviewSidePanel';
import type { Project, ProjectSession } from '../../types/app';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it.each([false, true])('opens only Git and preserves drafts on close (mobile=%s)', async isMobile => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ branch: 'main', repositoryRoot: '/workspace', entries: [] }) });
  const content = (request?: ReviewOpenRequest) => <ChatReviewProvider project={{ name: 'workspace', fullPath: '/workspace' } as Project} session={{ id: 'session' } as ProjectSession} openRequest={request} onOpen={() => {}}>
    <textarea aria-label="聊天草稿" /><ChatReviewSidePanel width={400} minWidth={300} maxWidth={800} isMobile={isMobile} onResizeStart={() => {}} onResizeBy={() => {}} />
  </ChatReviewProvider>;
  const view = render(content({ tab: 'git', sequence: 1 }));
  await screen.findByTestId('chat-review-panel');
  expect(screen.queryByLabelText('检查点历史')).toBeNull(); expect(screen.queryByText('恢复预览')).toBeNull();
  const draft = screen.getByLabelText('聊天草稿'); fireEvent.change(draft, { target: { value: '保留草稿' } });
  fireEvent.click(screen.getByLabelText('收起 Git 面板'));
  expect(screen.queryByTestId('chat-review-panel')).toBeNull(); expect((draft as HTMLTextAreaElement).value).toBe('保留草稿');
  view.rerender(content({ tab: 'git', sequence: 2 })); await screen.findByTestId('chat-review-panel');
  expect(mocks.fetch.mock.calls.every(([url]) => !String(url).includes('checkpoints'))).toBe(true);
});
