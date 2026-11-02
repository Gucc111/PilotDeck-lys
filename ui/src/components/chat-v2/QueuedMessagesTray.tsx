import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, ChevronRight, CornerDownRight, Loader2, MoreHorizontal, MoveUp, Pause, Play, Route, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import type { InputQueueState } from '../chat/types/queuedInput';
import { isSendingInput } from '../chat/types/queuedInput';
import type { TeamRuntimeActivation, TeamRuntimeMessage } from '../../../../src/team/runtimeTypes';
import { getQueueMenuPosition } from './queueMenuPosition';

type QueuedMessagesTrayProps = {
  state: InputQueueState;
  isLoading: boolean;
  onResume: () => void;
  onSteer: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onMoveToFront: (itemId: string) => void;
  teamActivation?: TeamRuntimeActivation | null;
  onDeleteTeamMessage?: (message: TeamRuntimeMessage) => Promise<void>;
};

export default function QueuedMessagesTray({
  state,
  isLoading,
  onResume,
  onSteer,
  onDelete,
  onMoveToFront,
  teamActivation,
  onDeleteTeamMessage,
}: QueuedMessagesTrayProps) {
  const { t } = useTranslation('chat');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenuId) return undefined;

    const updatePosition = () => {
      const button = menuButtonRefs.current.get(openMenuId);
      if (!button) {
        setOpenMenuId(null);
        return;
      }
      setMenuPosition(getQueueMenuPosition({
        anchor: button.getBoundingClientRect(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }));
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        menuRef.current?.contains(target)
        || menuButtonRefs.current.get(openMenuId)?.contains(target)
      ) return;
      setOpenMenuId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpenMenuId(null);
      menuButtonRefs.current.get(openMenuId)?.focus();
    };

    updatePosition();
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [openMenuId]);

  const queuedItems = state.items.filter((item) => !isSendingInput(item) && item.status !== 'invalidated');
  const leader = teamActivation?.participants.find(participant => participant.role === 'leader');
  const teamMessages = teamActivation?.status === 'active' && leader
    ? teamActivation.messages.filter(message => message.recipientId === leader.id
      && message.stopVersion === teamActivation.stopVersion && !message.deletedAt
      && (message.status === 'queued' || message.status === 'preparing'))
    : [];
  if (queuedItems.length === 0 && teamMessages.length === 0) return null;
  const hasDeliveryUncertainItem = queuedItems.some((item) => item.status === 'delivery_uncertain');

  return (
    <section
      aria-label={t('inputQueue.label', { defaultValue: 'Queued messages' }) as string}
      aria-live="polite"
      className="relative z-0 mx-3 -mb-3 overflow-hidden rounded-t-[22px] border border-b-0 border-neutral-200 bg-white pb-3 shadow-[0_-8px_24px_rgba(0,0,0,0.025)] dark:border-neutral-800 dark:bg-neutral-950"
    >
      {state.paused && queuedItems.length > 0 ? (
        <div className="flex min-h-11 items-center gap-2 border-b border-neutral-100 px-4 text-[13px] text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
          <Pause className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">
            {state.pauseReason === 'restart_recovery'
              ? hasDeliveryUncertainItem
                ? t('inputQueue.pausedAfterUncertainDelivery', {
                  defaultValue: 'A message may already have been sent before restart. Retry only if needed',
                })
                : t('inputQueue.pausedAfterRestart', { defaultValue: 'Queued messages were restored and are paused' })
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
            {hasDeliveryUncertainItem
              ? t('inputQueue.retryUncertain', { defaultValue: 'Retry' })
              : t('inputQueue.resume', { defaultValue: 'Continue' })}
          </button>
        </div>
      ) : null}

      <div data-testid="queue-scroll-region" className="max-h-[156px] overflow-y-auto">
        {queuedItems.map((item, index) => {
          const busy = item.status === 'steering' || item.status === 'dispatching';
          const deliveryUncertain = item.status === 'delivery_uncertain';
          return (
            <div
              key={item.id}
              className="flex min-h-11 items-center gap-2 border-b border-neutral-100 px-4 last:border-b-0 dark:border-neutral-800"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />
              ) : deliveryUncertain ? (
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-amber-500"
                  aria-label={t('inputQueue.deliveryUncertain', { defaultValue: 'Delivery status uncertain' }) as string}
                />
              ) : (
                <CornerDownRight className="h-4 w-4 shrink-0 text-neutral-400" />
              )}
              <div className="min-w-0 flex-1 py-2">
                <p className="truncate text-[13px] text-neutral-800 dark:text-neutral-200">
                  {item.displayText || t('inputQueue.attachmentOnly', { defaultValue: 'Attachment message' })}
                </p>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {item.status === 'steering'
                    ? t('inputQueue.nextModelRequest', { defaultValue: 'Handled at the next model request' })
                    : t('inputQueue.nextUserMessage', { defaultValue: 'Treated as the next user message' })}
                </p>
              </div>
              {item.attachmentCount ? (
                <span className="shrink-0 text-[11px] text-neutral-400">+{item.attachmentCount}</span>
              ) : null}
              <button
                type="button"
                onClick={() => onSteer(item.id)}
                disabled={!isLoading || state.paused || busy || deliveryUncertain}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] transition',
                  isLoading && !state.paused && !busy && !deliveryUncertain
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
              {index > 0 ? (
                <div>
                  <button
                    ref={(node) => {
                      if (node) menuButtonRefs.current.set(item.id, node);
                      else menuButtonRefs.current.delete(item.id);
                    }}
                    type="button"
                    onClick={() => {
                      if (openMenuId === item.id) {
                        setOpenMenuId(null);
                        return;
                      }
                      const button = menuButtonRefs.current.get(item.id);
                      if (button) {
                        setMenuPosition(getQueueMenuPosition({
                          anchor: button.getBoundingClientRect(),
                          viewportWidth: window.innerWidth,
                          viewportHeight: window.innerHeight,
                        }));
                      }
                      setOpenMenuId(item.id);
                    }}
                    disabled={busy || deliveryUncertain}
                    className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-35 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                    aria-label={t('inputQueue.more', { defaultValue: 'More queue actions' }) as string}
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === item.id}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {openMenuId === item.id && typeof document !== 'undefined' ? createPortal(
                    <div
                      ref={menuRef}
                      role="menu"
                      aria-label={t('inputQueue.more', { defaultValue: 'More queue actions' }) as string}
                      className="fixed z-[120] min-w-36 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                      style={menuPosition}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (
                          !event.currentTarget.contains(nextTarget)
                          && !menuButtonRefs.current.get(item.id)?.contains(nextTarget)
                        ) setOpenMenuId(null);
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenuId(null);
                          onMoveToFront(item.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
                      >
                        <MoveUp className="h-3.5 w-3.5" />
                        {t('inputQueue.moveToFront', { defaultValue: 'Move to front' })}
                      </button>
                    </div>,
                    document.body,
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {teamMessages.map(message => <PendingTeamMessage
          key={`${teamActivation!.id}:${message.id}`}
          message={message}
          sender={teamActivation!.participants.find(participant => participant.id === message.senderId)?.profile.config.displayName || message.senderId}
          onDelete={onDeleteTeamMessage}
        />)}
      </div>
    </section>
  );
}

function PendingTeamMessage({ message, sender, onDelete }: {
  message: TeamRuntimeMessage;
  sender: string;
  onDelete?: (message: TeamRuntimeMessage) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const system = message.senderId === 'system' || Boolean(message.kind && message.kind !== 'member');
  const source = system
    ? t('inputQueue.systemNotification', { defaultValue: 'System notification' })
    : `Teammate · ${sender}`;
  const remove = async () => {
    if (busy || !onDelete) return;
    setBusy(true); setError(null);
    try { await onDelete(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div data-message-id={message.id} className="border-b border-neutral-100 px-4 last:border-b-0 dark:border-neutral-800">
    <div className="flex min-h-11 items-center gap-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400"/> : <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400"/>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-neutral-800 dark:text-neutral-200">{source}</span>
          <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{t('inputQueue.nextModelRequest', { defaultValue: 'Handled at the next model request' })}</span>
        </span>
      </button>
      {!system && onDelete && <button type="button" disabled={busy} onClick={() => void remove()}
        aria-label={t('inputQueue.delete', { defaultValue: 'Delete queued message' }) as string}
        title={t('teamInteractions.deleteMessageHint') as string}
        className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-35 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
        {busy ? <Loader2 className="h-4 w-4 animate-spin"/> : <Trash2 className="h-4 w-4"/>}
      </button>}
    </div>
    {expanded && <p className="whitespace-pre-wrap break-words pb-3 pl-6 text-[13px] text-neutral-700 dark:text-neutral-300">{message.text}</p>}
    {(error || (expanded && message.error)) && <p role="alert" className="pb-2 text-[12px] text-red-600 dark:text-red-400">{error || message.error}</p>}
  </div>;
}
