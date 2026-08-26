import { useState } from 'react';
import { CornerDownRight, Loader2, MoreHorizontal, MoveUp, Pause, Play, Route, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import type { InputQueueState } from '../chat/types/queuedInput';

type QueuedMessagesTrayProps = {
  state: InputQueueState;
  isLoading: boolean;
  onResume: () => void;
  onSteer: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onMoveToFront: (itemId: string) => void;
};

export default function QueuedMessagesTray({
  state,
  isLoading,
  onResume,
  onSteer,
  onDelete,
  onMoveToFront,
}: QueuedMessagesTrayProps) {
  const { t } = useTranslation('chat');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  if (state.items.length === 0) return null;

  return (
    <section
      aria-label={t('inputQueue.label', { defaultValue: 'Queued messages' }) as string}
      aria-live="polite"
      className="relative z-0 mx-3 -mb-3 overflow-hidden rounded-t-[22px] border border-b-0 border-neutral-200 bg-white pb-3 shadow-[0_-8px_24px_rgba(0,0,0,0.025)] dark:border-neutral-800 dark:bg-neutral-950"
    >
      {state.paused ? (
        <div className="flex min-h-11 items-center gap-2 border-b border-neutral-100 px-4 text-[13px] text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
          <Pause className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">
            {state.pauseReason === 'restart_recovery'
              ? t('inputQueue.pausedAfterRestart', { defaultValue: 'Queued messages were restored and are paused' })
              : state.pauseReason === 'previous_turn_failed'
                ? t('inputQueue.pausedAfterFailure', { defaultValue: 'The previous response failed, so the queue is paused' })
                : t('inputQueue.pausedAfterStop', { defaultValue: 'You stopped the current response, so the queue is paused' })}
          </span>
          <button
            type="button"
            onClick={onResume}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <Play className="h-3.5 w-3.5" fill="currentColor" />
            {t('inputQueue.resume', { defaultValue: 'Continue' })}
          </button>
        </div>
      ) : null}

      <div className="max-h-[156px] overflow-y-auto">
        {state.items.map((item, index) => {
          const busy = item.status === 'steering' || item.status === 'dispatching';
          return (
            <div
              key={item.id}
              className="flex min-h-11 items-center gap-2 border-b border-neutral-100 px-4 last:border-b-0 dark:border-neutral-800"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />
              ) : (
                <CornerDownRight className="h-4 w-4 shrink-0 text-neutral-400" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800 dark:text-neutral-200">
                {item.displayText || t('inputQueue.attachmentOnly', { defaultValue: 'Attachment message' })}
              </span>
              {item.attachmentCount ? (
                <span className="shrink-0 text-[11px] text-neutral-400">+{item.attachmentCount}</span>
              ) : null}
              <button
                type="button"
                onClick={() => onSteer(item.id)}
                disabled={!isLoading || state.paused || busy}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] transition',
                  isLoading && !state.paused && !busy
                    ? 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                    : 'cursor-not-allowed text-neutral-300 dark:text-neutral-700',
                )}
                title={t('inputQueue.steerHint', {
                  defaultValue: 'Add this message before the next model call in the current task',
                }) as string}
              >
                <Route className="h-3.5 w-3.5" />
                {t('inputQueue.steer', { defaultValue: 'Adjust direction' })}
              </button>
              <button
                type="button"
                onClick={() => onDelete(item.id)}
                disabled={item.status === 'dispatching'}
                className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                aria-label={t('inputQueue.delete', { defaultValue: 'Delete queued message' }) as string}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <div
                className="relative"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpenMenuId(null);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOpenMenuId(null);
                    event.stopPropagation();
                  }
                }}
              >
                <button
                  type="button"
                  onClick={() => setOpenMenuId((current) => current === item.id ? null : item.id)}
                  disabled={busy}
                  className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-35 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  aria-label={t('inputQueue.more', { defaultValue: 'More queue actions' }) as string}
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === item.id}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {openMenuId === item.id ? (
                  <div role="menu" className={cn(
                    'absolute right-0 z-20 min-w-36 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900',
                    index === 0 ? 'top-8' : 'bottom-8',
                  )}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={index === 0}
                      onClick={() => {
                        setOpenMenuId(null);
                        onMoveToFront(item.id);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      <MoveUp className="h-3.5 w-3.5" />
                      {t('inputQueue.moveToFront', { defaultValue: 'Move to front' })}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
