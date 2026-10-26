import type { MouseEvent } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import ToolSidePanel from '../main-content/view/subcomponents/ToolSidePanel';
import { useChatReview } from './ChatReviewContext';
import GitReviewTab from './GitReviewTab';
export default function ChatReviewSidePanel({ width, minWidth, maxWidth, isMobile, onResizeStart, onResizeBy }: {
  width: number; minWidth: number; maxWidth: number; isMobile: boolean; onResizeStart: (event: MouseEvent<HTMLDivElement>) => void; onResizeBy: (delta: number) => void;
}) {
  const review = useChatReview();
  if (!review?.panelOpen) return null;
  const header = <div className="flex min-w-0 flex-1 items-center gap-1"><span className="text-xs font-medium">Git</span><button type="button" className="ml-auto rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="刷新 Git 状态" onClick={() => void review.refreshGit()}><RefreshCw className={`h-3.5 w-3.5 ${review.loading ? 'animate-spin' : ''}`} /></button></div>;
  return <ToolSidePanel title="Git" icon={GitBranch} headerContent={header} width={width} minWidth={minWidth} maxWidth={maxWidth} isMobile={isMobile} closeLabel="收起 Git 面板" resizeLabel="调整 Git 面板宽度" onClose={review.close} onResizeStart={onResizeStart} onResizeBy={onResizeBy}>
    <div className="h-full min-h-0 overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100" data-testid="chat-review-panel"><GitReviewTab /></div>
  </ToolSidePanel>;
}
