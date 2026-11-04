import { McpConnectionStatus } from "../mcp/McpConnectionStatus";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useSessionWatch } from '../../hooks/useSessionWatch';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import { teamCommand } from '../team-library/api';
import type { TeamRuntimeActivation, TeamRuntimeParticipantMessages, TeamRuntimeView, TeamParticipantMessage } from '../../../../src/team/runtimeTypes';
import SubagentDetailMessageFlow from '../chat-v2/SubagentDetailMessageFlow';
import { createCachedDiffCalculator } from '../chat/utils/messageTransforms';
import { participantChatMessages, mergeParticipantMessages } from './participantMessages';
import './TeamMode.css';

type StreamUpdate = { sessionKey?: string; sessionId?: string; activationId: string; participantId: string; stopVersion: number; streamEpoch: string; revision: number; streaming: boolean; messages: TeamParticipantMessage[]; reload?: boolean };

/** Read-only route. API snapshots recover disk plus the current streaming turn;
 * socket frames upsert stable blocks and never initiate another model call. */
export default function TeamTeammateRouteView() {
  const { rootSessionKey = '', activationId = '', participantId = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('chat', { keyPrefix: 'teamInteraction.readOnlyChat' });
  const { subscribe, ws, sendMessage } = useWebSocket();
  useSessionWatch({ sessionId: rootSessionKey, ws, sendMessage });
  const [activation, setActivation] = useState<TeamRuntimeActivation | null>(null);
  const [messages, setMessages] = useState<TeamParticipantMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const owner = useRef<TeamRuntimeActivation | null>(null);
  const streamVersion = useRef<{ epoch: string; revision: number } | null>(null);
  // While an HTTP snapshot is loading, retain the latest update for each
  // block, so a slower snapshot cannot erase text already received by WS.
  const buffered = useRef(new Map<string, { frame: StreamUpdate; message: TeamParticipantMessage }>());
  const latestFrame = useRef<StreamUpdate | null>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const participant = activation?.participants.find(item => item.id === participantId && item.role === 'teammate');
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError(null);
    try {
      if (!rootSessionKey || !activationId || !participantId) throw new Error(t('invalidAddress'));
      const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_get', sessionKey: rootSessionKey });
      if (sequence !== requestSequence.current) return;
      if (!view.activation || view.activation.id !== activationId || !view.activation.participants.some(item => item.id === participantId && item.role === 'teammate')) throw new Error(t('unavailable'));
      const current = view.activation;
      owner.current = current;
      setActivation(current);
      let cursor: string | undefined;
      let allMessages: TeamParticipantMessage[] = [];
      let first: TeamRuntimeParticipantMessages | undefined;
      const cursors = new Set<string>();
      do {
        const page = await teamCommand<TeamRuntimeParticipantMessages>({ action: 'runtime_participant_messages', sessionKey: rootSessionKey, activationId, stopVersion: current.stopVersion, participantId, cursor, limit: 200 });
        if (sequence !== requestSequence.current) return;
        if (page.sessionKey !== rootSessionKey || page.activationId !== activationId || page.participantId !== participantId || (page.stopVersion !== undefined && page.stopVersion !== current.stopVersion) || (first?.streamEpoch && page.streamEpoch !== first.streamEpoch)) throw new Error(t('paginationChanged'));
        first ??= page;
        allMessages = mergeParticipantMessages(allMessages, page.messages ?? []);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error(t('paginationChanged'));
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const newer = [...buffered.current.values()].filter(({ frame }) => frame.stopVersion === current.stopVersion && frame.streamEpoch === first?.streamEpoch && frame.revision > (first?.revision ?? -1));
      allMessages = mergeParticipantMessages(allMessages, newer.map(item => item.message));
      const latest = latestFrame.current;
      const useLatest = latest && latest.stopVersion === current.stopVersion && latest.streamEpoch === first?.streamEpoch && latest.revision > (first?.revision ?? -1);
      streamVersion.current = { epoch: first?.streamEpoch ?? '', revision: useLatest ? latest.revision : first?.revision ?? 0 };
      buffered.current.clear();
      setMessages(allMessages);
      setStreaming(useLatest ? latest.streaming : first?.streaming === true);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      owner.current = null;
      setStreaming(false); setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [rootSessionKey, activationId, participantId, t]);
  useEffect(() => {
    owner.current = null; streamVersion.current = null; latestFrame.current = null; buffered.current.clear();
    setActivation(null); setMessages([]); setStreaming(false);
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);
  useEffect(() => subscribe((incoming: any) => {
    if (incoming?.type === 'websocket-reconnected') { void load(); return; }
    if (incoming?.type !== 'team-participant-message') return;
    const frame = (incoming.payload || incoming) as StreamUpdate;
    if ((frame.sessionKey || frame.sessionId) !== rootSessionKey || frame.activationId !== activationId || frame.participantId !== participantId) return;
    if (owner.current && frame.stopVersion !== owner.current.stopVersion) return;
    if (typeof frame.revision !== 'number' || !frame.streamEpoch || !Array.isArray(frame.messages)) return;
    const previous = streamVersion.current;
    // A new server epoch is accepted only through an authoritative reload.
    if (previous?.epoch && frame.streamEpoch !== previous.epoch) { void load(); return; }
    if (previous?.epoch === frame.streamEpoch && frame.revision <= previous.revision) return;
    streamVersion.current = { epoch: frame.streamEpoch, revision: frame.revision };
    latestFrame.current = frame;
    for (const message of frame.messages) buffered.current.set(message.id, { frame, message });
    if (owner.current) { setMessages(current => mergeParticipantMessages(current, frame.messages)); setStreaming(frame.streaming); }
    if (frame.reload) void load();
  }), [subscribe, load, rootSessionKey, activationId, participantId]);
  const rendered = useMemo(() => participantChatMessages(messages), [messages]);
  const title = t('title', { name: participant?.profile.config.displayName || participantId });
  return <FindShortcutProvider activeScope="chat"><main className="team-mode-route-page" aria-label={title}>
    <McpConnectionStatus activationId={activationId} participantId={participantId} />
    <div className="team-mode-dialog team-teammate-chat-dialog">
      <div className="team-mode-header"><button type="button" onClick={() => navigate(`/session/${encodeURIComponent(rootSessionKey)}`)} aria-label={t('back')}><ArrowLeft size={16}/></button><h2>{title}</h2>{streaming && <span className="team-mode-muted">{t('streaming')}</span>}<button type="button" onClick={() => void load()} aria-label={t('refresh')}><RefreshCw size={15}/></button></div>
      {loading && !rendered.length && <div className="team-teammate-chat-empty"><Loader2 size={18} className="animate-spin"/></div>}
      {error ? <div className="team-mode-error" role="alert">{error}<button type="button" onClick={() => void load()}>{t('retry')}</button></div> : <div className="team-teammate-message-flow">
        {!loading && !rendered.length && <p className="team-mode-muted">{t('empty')}</p>}
        <SubagentDetailMessageFlow messages={rendered} provider="pilotdeck" selectedProject={null} createDiff={createDiff} isRunning={streaming} />
      </div>}
    </div>
  </main></FindShortcutProvider>;
}
