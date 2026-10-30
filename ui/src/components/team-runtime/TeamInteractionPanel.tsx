import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, ShieldCheck, UserRound, ClipboardList, ChevronDown, ChevronRight, Trash2, Loader2 } from 'lucide-react';
import type { TeamRuntimeMessage } from '../../../../src/team/runtimeTypes';
import { useTranslation } from 'react-i18next';
import type { TeamModeState } from './useTeamMode';
import type { TeamHumanInteraction } from './teamInteractionTypes';
import { interactionRequestInput, interactionToolName } from './teamInteractionTypes';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import { extractPlanMarkdown } from '../chat/tools/components/InteractiveRenderers/ExitPlanModePanel';
import { MarkdownContent } from '../chat/tools/components/ContentRenderers/MarkdownContent';
import type { PendingPermissionRequest } from '../chat/types/types';
import { formatToolInputForDisplay } from '../chat/utils/chatPermissions';
import { TeamDialog } from './TeamDialog';

type InteractionResponse = { decision?: 'allow' | 'deny' | 'approve' | 'decline' | 'cancel'; answer?: unknown; reason?: string };
type Filter = 'all' | 'pending' | 'handled';
type SavedInteractionView = { sections?: Record<string, boolean>; selected?: string | null; filter?: Filter };
function readSavedView(key: string): SavedInteractionView {
  try { const value = JSON.parse(window.sessionStorage.getItem(key) || 'null'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function saveView(key: string, value: SavedInteractionView) {
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* optional storage */ }
}
function toPendingRequest(item: TeamHumanInteraction): PendingPermissionRequest {
  return { requestId: item.requestId, toolName: interactionToolName(item), input: interactionRequestInput(item), receivedAt: new Date(item.createdAt), isElicitation: item.kind !== 'tool_permission' };
}

function ReadOnlyInteraction({ item }: { item: TeamHumanInteraction }) {
  const { t } = useTranslation('chat');
  const input = interactionRequestInput(item);
  const questions = input && typeof input === 'object' && 'questions' in input && Array.isArray(input.questions) ? input.questions as Record<string, unknown>[] : [];
  return <div className="team-interaction-history">
    <h3>{t('teamInteractions.request')}</h3>
    {item.kind === 'plan_approval' ? <MarkdownContent content={extractPlanMarkdown(input)} /> : item.kind === 'user_question' && questions.length
      ? questions.map((question, index) => <div key={index}><strong>{String(question.question || question.header || '')}</strong>{Array.isArray(question.options) && <ul>{question.options.map((option, optionIndex) => <li key={optionIndex}>{typeof option === 'string' ? option : `${String(option.label || option.value || '')}${option.description ? ` — ${option.description}` : ''}`}</li>)}</ul>}</div>)
      : <><strong>{interactionToolName(item)}</strong><pre>{formatToolInputForDisplay(input)}</pre></>}
    <h3>{t('teamInteractions.result')}</h3>
    <p>{t(`teamInteractions.status.${item.status}`)}{item.resolvedAt ? ` · ${new Date(item.resolvedAt).toLocaleString()}` : ''}</p>
    {item.resolution !== undefined && <pre>{formatToolInputForDisplay(item.resolution)}</pre>}
    {item.error && <p role="alert" className="team-mode-error">{item.error}</p>}
  </div>;
}

function InteractionDialog({ item, onClose, onRespond }: { item: TeamHumanInteraction; onClose: () => void; onRespond: (response: InteractionResponse) => Promise<void> }) {
  const { t } = useTranslation('chat');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const pending = item.status === 'pending';
  const submit = async (response: InteractionResponse) => {
    if (busyRef.current || !pending) return;
    busyRef.current = true; setBusy(true); setResponseError(null);
    try { await onRespond(response); }
    catch (cause) { setResponseError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const handleDecision = (_requestId: string | string[], decision: { allow?: boolean; message?: string; updatedInput?: unknown }) => {
    const updated = decision.updatedInput && typeof decision.updatedInput === 'object' ? decision.updatedInput as Record<string, unknown> : undefined;
    const answers = updated?.answers;
    const planAction = item.kind === 'plan_approval' && answers && typeof answers === 'object'
      ? Object.values(answers).flatMap(value => Array.isArray(value) ? value : [value]).find(value => value === 'execute_plan' || value === 'continue_planning') : undefined;
    if (item.kind === 'plan_approval') {
      const annotations = updated?.annotations;
      const notes = annotations && typeof annotations === 'object' ? Object.values(annotations).map(value => value && typeof value === 'object' && 'notes' in value ? String(value.notes) : '').filter(Boolean).join('\n') : undefined;
      void submit({ decision: planAction === 'execute_plan' ? 'approve' : 'decline', answer: { type: 'answered', ...updated }, reason: decision.message || notes || undefined });
    } else if (item.kind === 'user_question') {
      void submit(decision.allow && answers && typeof answers === 'object' && Object.keys(answers).length
        ? { answer: { type: 'answered', answers, ...(updated?.annotations ? { annotations: updated.annotations } : {}) }, reason: decision.message } : { decision: 'cancel', reason: decision.message });
    } else void submit({ decision: decision.allow ? 'allow' : 'deny', reason: decision.message });
  };
  return <TeamDialog title={`${item.participantDisplayName} · ${t(`teamInteractions.kind.${item.kind}`)}`} onClose={onClose} closeDisabled={busy} className="team-interaction-modal">
    <div className="team-mode-body">
      {pending ? <PermissionRequestsBanner pendingPermissionRequests={[toPendingRequest(item)]} handlePermissionDecision={handleDecision} handleGrantToolPermission={() => ({ success: false })} hideRemember disabled={busy} /> : <ReadOnlyInteraction item={item} />}
      {busy && <p role="status">{t('teamInteractions.responding')}</p>}
      {responseError && <p className="team-mode-error" role="alert">{t('teamInteractions.responseError', { error: responseError })}</p>}
    </div>
  </TeamDialog>;
}

const kinds = ['tool_permission', 'user_question', 'plan_approval'] as const;
function ReceivedMessage({ message, sender, onDelete }: { message: TeamRuntimeMessage; sender: string; onDelete: (message: TeamRuntimeMessage) => Promise<void> }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const system = message.senderId === 'system' || (message.kind && message.kind !== 'member');
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onDelete(message); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="team-received-message" data-message-id={message.id}>
    <div className="team-received-message-meta"><strong>{system ? t('teamInteractions.system') : sender}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
      {!system && <button type="button" className="team-message-delete" title={t('teamInteractions.deleteMessageHint')} aria-label={t('teamInteractions.deleteMessage')} disabled={busy} onClick={() => void remove()}>{busy ? <Loader2 size={14} className="animate-spin"/> : <Trash2 size={14}/>}</button>}
    </div>
    <button type="button" className={`team-message-content ${expanded ? 'is-expanded' : ''}`} onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{message.text}</button>
    <span className="team-mode-muted">{t(`teamInteractions.messageStatus.${message.status}`, { defaultValue: message.status })}</span>
    {message.error && <p className="team-mode-error">{message.error}</p>}
    {error && <p role="alert" className="team-mode-error">{error}</p>}
  </div>;
}
function ParticipantCard({ participant, items, messages, status, stateKey, filter, onSelect, onViewChat, senderName, onDelete }: {
  participant: { id: string; role: string; profile?: { config?: { displayName?: string } } }; items: TeamHumanInteraction[]; status: string; stateKey: string; filter: Filter;
  onSelect: (id: string) => void; onViewChat: (participantId: string) => void;
  messages: TeamRuntimeMessage[]; senderName: (id: string) => string; onDelete: (message: TeamRuntimeMessage) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const [sections, setSections] = useState<Record<string, boolean>>(() => ({ messages: true, tool_permission: true, user_question: true, plan_approval: true, ...readSavedView(stateKey).sections }));
  const [messageLimit, setMessageLimit] = useState(50);
  const visibleMessages = messages.slice(-messageLimit);
  useEffect(() => saveView(stateKey, { sections }), [stateKey, sections]);
  const byKind = useMemo(() => Object.fromEntries(kinds.map(kind => [kind, items.filter(item => item.kind === kind && (filter === 'all' || (filter === 'pending' ? item.status === 'pending' : item.status !== 'pending')))])) as Record<typeof kinds[number], TeamHumanInteraction[]>, [items, filter]);
  return <article className="team-interaction-teammate-card">
    <div className="team-interaction-teammate-header"><div><strong>{participant.profile?.config?.displayName || participant.id}</strong><span className="team-mode-muted">{participant.role === 'leader' ? 'Leader' : 'Teammate'} · {status}</span></div><button type="button" onClick={() => onViewChat(participant.id)}><MessageCircle size={14}/>{t('teamInteractions.viewChat')}</button></div>
    <section className="team-interaction-section"><button type="button" className="team-interaction-section-title" aria-expanded={Boolean(sections.messages)} onClick={() => setSections(value => ({ ...value, messages: !value.messages }))}>{sections.messages ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<MessageCircle size={14}/>{t('teamInteractions.messages')}<span className="team-interaction-count">{messages.length}</span></button>
      {sections.messages && <div className="team-interaction-section-items">{messages.length > messageLimit && <button type="button" onClick={() => setMessageLimit(value => value + 50)}>{t('teamInteractions.earlierMessages')}</button>}{messages.length ? visibleMessages.map(message => <ReceivedMessage key={message.id} message={message} sender={senderName(message.senderId)} onDelete={onDelete}/>) : <span className="team-mode-muted">{t('teamInteractions.noRecords')}</span>}</div>}
    </section>
    {participant.role !== 'leader' && kinds.map(kind => <section key={kind} className="team-interaction-section">
      <button type="button" className="team-interaction-section-title" aria-expanded={Boolean(sections[kind])} onClick={() => setSections(value => ({ ...value, [kind]: !value[kind] }))}>{sections[kind] ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} {kind === 'tool_permission' ? <ShieldCheck size={14}/> : kind === 'user_question' ? <UserRound size={14}/> : <ClipboardList size={14}/>} {t(`teamInteractions.kind.${kind}`)}<span className="team-interaction-count">{byKind[kind].length}</span></button>
      {sections[kind] && <div className="team-interaction-section-items">{byKind[kind].length ? byKind[kind].map(item => <div key={item.id} className={`team-interaction-entry ${item.status === 'pending' ? 'is-pending' : 'is-handled'}`}>
        <button type="button" className="team-interaction-entry-button" onClick={() => onSelect(item.id)} aria-haspopup="dialog"><span className="team-interaction-entry-kind">{item.toolName || t(`teamInteractions.kind.${kind}`)}</span><time className="team-interaction-entry-time" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString()}</time><span className="team-interaction-entry-status">{t(`teamInteractions.status.${item.status}`)}</span><ChevronRight size={14}/></button>
      </div>) : <span className="team-mode-muted">{t('teamInteractions.noRecords')}</span>}</div>}
    </section>)}
  </article>;
}

export default function TeamInteractionPanel({ mode, onClose, onViewChat }: { mode: TeamModeState; onClose: () => void; onViewChat: (participantId: string) => void }) {
  const { t } = useTranslation('chat');
  const stateKey = `pilotdeck:team-interactions:${mode.activation?.id || 'none'}:panel`;
  const saved = useMemo(() => readSavedView(stateKey), [stateKey]);
  const [filter, setFilter] = useState<Filter>(saved.filter || 'all');
  const [selected, setSelected] = useState<string | null>(saved.selected || null);
  useEffect(() => { setFilter(saved.filter || 'all'); setSelected(saved.selected || null); }, [saved]);
  useEffect(() => saveView(stateKey, { filter, selected }), [stateKey, filter, selected]);
  const participants = [...(mode.activation?.participants || [])].sort((a, b) => Number(b.role === 'leader') - Number(a.role === 'leader'));
  const interactions = mode.interactions || [];
  const pendingCount = interactions.filter(item => item.status === 'pending').length;
  const selectedItem = interactions.find(item => item.id === selected);
  const participantStatus = (participantId: string): string => {
    if (interactions.some(item => item.participantId === participantId && item.status === 'pending')) return t('teamInteractions.waitingInteraction');
    const turn = mode.activation?.turns?.find(item => item.participantId === participantId && ['preparing', 'running', 'waiting_approval'].includes(item.status));
    return turn ? t(`teamMode.status.${turn.status}`, { defaultValue: turn.status }) : t(`teamMode.${mode.activation?.status === 'stopping' ? 'stopping' : mode.activation?.status === 'stopped' ? 'stopped' : 'idle'}`);
  };
  return <>
    <TeamDialog title={pendingCount ? t('teamInteractions.titlePending', { count: pendingCount }) : t('teamInteractions.title')} onClose={onClose} side>
      <div className="team-mode-body" aria-hidden={Boolean(selectedItem)}>
        <div className="team-interaction-filters" role="group" aria-label={t('teamInteractions.filterLabel')}>{(['all', 'pending', 'handled'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`teamInteractions.filter.${value}`)}</button>)}</div>
        {mode.error && <div role="alert" className="team-mode-error">{mode.error}<button type="button" onClick={() => void mode.refresh()}>{t('teamMode.retry')}</button></div>}
        {!participants.length && <p className="team-mode-muted">{t('teamInteractions.noTeammates')}</p>}
        {participants.map(participant => <ParticipantCard key={`${mode.activation?.id}:${participant.id}`} participant={participant} stateKey={`pilotdeck:team-interactions:${mode.activation?.id}:${participant.id}`} filter={filter} items={interactions.filter(item => item.participantId === participant.id)} messages={(mode.activation?.messages || []).filter(item => item.recipientId === participant.id && item.status !== 'deleted' && !item.deletedAt && (filter === 'all' || (filter === 'pending' ? ['queued', 'preparing', 'sending'].includes(item.status) : !['queued', 'preparing', 'sending'].includes(item.status))))} senderName={id => participants.find(item => item.id === id)?.profile.config.displayName || id} onDelete={mode.deleteMessage} status={participantStatus(participant.id)} onSelect={setSelected} onViewChat={onViewChat}/>)}
      </div>
    </TeamDialog>
    {selectedItem && <InteractionDialog key={selectedItem.id} item={selectedItem} onClose={() => setSelected(null)} onRespond={response => mode.respondInteraction(selectedItem, response)} />}
  </>;
}
