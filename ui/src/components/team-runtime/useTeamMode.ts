import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../../types/app';
import { isGeneralProject } from '../app-shell/appShellSelection';
import { teamCommand, newRequestToken, refOf, workspaceKey, type TeamDefinition, type TeamLibrary } from '../team-library/api';
import { safeLocalStorage } from '../chat/utils/chatStorage';
import type { TeamExecutionSelection, TeamRuntimeActivation, TeamRuntimeProbe, TeamRuntimeView, TeamRuntimeInteractionResponse } from '../../../../src/team/runtimeTypes';
import type { TeamHumanInteraction } from './teamInteractionTypes';
import { activationInteractions } from './teamInteractionTypes';
import { useOptionalWebSocket } from '../../contexts/WebSocketContext';
import { useTranslation } from 'react-i18next';

/** Terminal records never regress to pending; events arriving during a paged
 * snapshot are retained until a later authoritative snapshot includes them. */
function mergeInteractions(snapshot: TeamHumanInteraction[], current: TeamHumanInteraction[], preserveMissing: boolean) {
  const previous = new Map(current.map(item => [item.id, item]));
  const merged = snapshot.map(item => {
    const old = previous.get(item.id);
    return old && old.status !== 'pending' && item.status === 'pending' ? old : item;
  });
  if (preserveMissing) for (const item of current) if (!merged.some(next => next.id === item.id)) merged.push(item);
  return merged;
}

export const hasTeamWork = (activation: TeamRuntimeActivation | null) => Boolean(activation?.status === 'active' && (
  activation.works.some(work => ['queued', 'running', 'waiting_information', 'waiting_approval'].includes(work.status))
  || activation.messages.some(message => message.status === 'queued')
  || activation.notifications.some(notification => !notification.deliveredAt && !notification.cancelledAt)
));

type TeamDraft = { team: TeamDefinition; selection: TeamExecutionSelection; sessionKey: string };
const draftKey = (projectKey: string) => `pilotdeck:team-draft:${projectKey}`;
function readDraft(projectKey: string): TeamDraft | null {
  try {
    const value = JSON.parse(safeLocalStorage.getItem(draftKey(projectKey)) || 'null');
    return value?.team?.id && value.selection?.requestToken && value.sessionKey?.startsWith('web:s_') ? value : null;
  } catch { return null; }
}

type Choice = { team: TeamDefinition; projectKey: string; requestToken: string; probe: TeamRuntimeProbe | null; checking: boolean; error: string | null };
export function useTeamMode({ sessionKey, project, projects, busy }: { sessionKey: string | null; project: Project | null; projects: Project[]; busy: boolean }) {
  const { t } = useTranslation('chat');
  const translateRef = useRef(t); translateRef.current = t;
  const [teams, setTeams] = useState<TeamDefinition[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activation, setActivation] = useState<TeamRuntimeActivation | null>(null);
  const [interactions, setInteractions] = useState<TeamHumanInteraction[]>([]);
  const activationRef = useRef(activation);
  const interactionsRef = useRef<TeamHumanInteraction[]>([]);
  const interactionVersion = useRef(0);
  const [history, setHistory] = useState<TeamRuntimeActivation[]>([]);
  const [continuationPaused, setContinuationPaused] = useState<'budget' | undefined>();
  const [draft, setDraft] = useState<TeamDraft | null>(() => !sessionKey ? readDraft(project ? workspaceKey(project) : '') : null);
  const [loading, setLoading] = useState(Boolean(sessionKey));
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const contextRef = useRef({ sessionKey, storageProjectKey: project ? workspaceKey(project) : '' });
  contextRef.current = { sessionKey, storageProjectKey: project ? workspaceKey(project) : '' };
  const requestSequence = useRef(0);
  const choiceSequence = useRef(0);
  const previousSessionKey = useRef(sessionKey);
  const webSocket = useOptionalWebSocket();
  const publishActivation = useCallback((next: TeamRuntimeActivation | null, preserveNewEvents = false) => {
    const previous = activationRef.current;
    const same = previous?.id === next?.id;
    const ledger = activationInteractions(next);
    const merged = same ? mergeInteractions(ledger, interactionsRef.current, preserveNewEvents) : ledger;
    const updated = next ? { ...next, interactions: merged } : null;
    activationRef.current = updated; interactionsRef.current = merged;
    setActivation(updated); setInteractions(merged);
  }, []);
  const catalog = useCallback(async () => {
    setCatalogLoading(true); setCatalogError(null);
    try { setTeams((await teamCommand<TeamLibrary>({ action: 'library' })).teams.filter(team => !team.archived)); }
    catch (cause) { setCatalogError((cause as Error).message); }
    finally { setCatalogLoading(false); }
  }, []);
  useEffect(() => { void catalog(); }, [catalog]);

  const refresh = useCallback(async () => {
    const key = contextRef.current.sessionKey;
    if (!key || key.startsWith('new-session-') || changingRef.current) return;
    const sequence = ++requestSequence.current;
    const eventVersion = interactionVersion.current;
    try {
      let view = await teamCommand<TeamRuntimeView>({ action: 'runtime_get', sessionKey: key, limit: 200 });
      // runtime_get pages the durable interaction ledger.  Hydrate all pages
      // before publishing a view so the panel never silently drops older
      // handled requests once a long-running Team exceeds the first page.
      if (view.activation && view.interactionsNextCursor) {
        const allInteractions = [...(view.activation.interactions || [])];
        let cursor: string | undefined = view.interactionsNextCursor;
        while (cursor) {
          const page: TeamRuntimeView = await teamCommand<TeamRuntimeView>({ action: 'runtime_get', sessionKey: key, cursor, limit: 200 });
          if (!page.activation || page.activation.id !== view.activation.id || page.activation.stopVersion !== view.activation.stopVersion) {
            // Never publish pages from different Team generations.
            throw new Error(translateRef.current('teamInteraction.readOnlyChat.paginationChanged'));
          }
          allInteractions.push(...(page.activation.interactions || []));
          cursor = page.interactionsNextCursor;
        }
        view = { ...view, activation: { ...view.activation, interactions: allInteractions } };
      }
      if (sequence !== requestSequence.current || contextRef.current.sessionKey !== key) return;
      const current = activationRef.current;
      if (current && view.activation?.id === current.id && (view.activation.stopVersion < current.stopVersion || (view.activation.stopVersion === current.stopVersion && view.activation.updatedAt < current.updatedAt))) return;
      publishActivation(view.activation?.status === 'closed' ? null : view.activation, eventVersion !== interactionVersion.current);
      setHistory(view.history || []); setContinuationPaused(view.continuationPaused);
      if (view.activation) { setDraft(null); safeLocalStorage.removeItem(draftKey(contextRef.current.storageProjectKey)); }
      setError(null); setLoading(false);
    } catch (cause) {
      if (sequence !== requestSequence.current || contextRef.current.sessionKey !== key) return;
      setError((cause as Error).message); setLoading(false);
    }
  }, [publishActivation]);
  const storageProjectKey = project ? workspaceKey(project) : '';
  useEffect(() => {
    if (!sessionKey) setDraft(readDraft(storageProjectKey));
  }, [storageProjectKey, sessionKey]);
  useEffect(() => {
    requestSequence.current += 1;
    choiceSequence.current += 1;
    setChoice(null); setPanelOpen(false); setError(null);
    const previous = previousSessionKey.current;
    previousSessionKey.current = sessionKey;
    if (previous && previous !== sessionKey && !previous.startsWith('new-session-')) setDraft(null);
    publishActivation(null); setHistory([]); setContinuationPaused(undefined);
    if (!sessionKey || sessionKey.startsWith('new-session-')) { setLoading(false); return; }
    setLoading(true); void refresh();
  }, [sessionKey, storageProjectKey, refresh, publishActivation]);
  useEffect(() => {
    if (!webSocket) return undefined;
    return webSocket.subscribe((message: any) => {
      const payload = message?.payload || message;
      const type = message?.type;
      if (type === 'websocket-reconnected') { void refresh(); return; }
      if (type !== 'team-interaction' && type !== 'team-interaction-updated' && type !== 'team_interaction') return;
      const current = activationRef.current;
      const item = payload?.interaction || payload;
      const eventSessionKey = payload?.sessionKey || payload?.sessionId || item?.sessionKey;
      if (!current || eventSessionKey !== contextRef.current.sessionKey || eventSessionKey !== current.sessionKey
        || item.activationId !== current.id || item.sessionKey !== current.sessionKey
        || item.stopVersion !== current.stopVersion || !item.id
        || !current.participants.some(participant => participant.id === item.participantId && participant.role === 'teammate')) return;
      if ((payload.activationId && payload.activationId !== current.id) || (payload.stopVersion !== undefined && payload.stopVersion !== current.stopVersion)) return;
      interactionVersion.current += 1;
      const next = mergeInteractions([...interactionsRef.current.filter(existing => existing.id !== item.id), item as TeamHumanInteraction], interactionsRef.current, false);
      interactionsRef.current = next;
      activationRef.current = { ...current, interactions: next };
      setInteractions(next); setActivation(activationRef.current);
    });
  }, [webSocket?.subscribe, refresh]);
  useEffect(() => {
    if (!sessionKey || sessionKey.startsWith('new-session-')) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, activation || busy ? 2000 : 10000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [sessionKey, activation?.id, busy, refresh]);

  const locked = busy || activation?.status === 'stopping' || hasTeamWork(activation) || changing || loading || Boolean(error);
  const probe = useCallback(async (next: Choice) => {
    const sequence = ++choiceSequence.current;
    setChoice({ ...next, checking: true, probe: null, error: null });
    const context = contextRef.current;
    try {
      const result = await teamCommand<TeamRuntimeProbe>({ action: 'runtime_probe', team: refOf(next.team),
        ...(context.sessionKey && !context.sessionKey.startsWith('new-session-') ? { sessionKey: context.sessionKey } : {}),
        ...(context.storageProjectKey ? { storageProjectKey: context.storageProjectKey } : {}),
        ...(next.projectKey ? { projectKey: next.projectKey } : {}) });
      if (sequence !== choiceSequence.current) return;
      setChoice({ ...next, projectKey: result.projectKey, probe: result, checking: false, error: null });
    } catch (cause) {
      if (sequence === choiceSequence.current) setChoice({ ...next, checking: false, probe: null, error: (cause as Error).message });
    }
  }, []);
  const selectTeam = useCallback((team: TeamDefinition) => {
    if (locked) return;
    const projectKey = project && !isGeneralProject(project) ? workspaceKey(project) : team.config.defaultProjectKey || '';
    void probe({ team, projectKey, requestToken: newRequestToken(), probe: null, checking: true, error: null });
  }, [locked, project, probe]);
  const cancelChoice = useCallback(() => { if (!changing) { choiceSequence.current += 1; setChoice(null); } }, [changing]);
  const confirmChoice = useCallback(async () => {
    if (!choice?.probe?.compatible || choice.checking || locked) return;
    changingRef.current = true; setChanging(true);
    requestSequence.current += 1;
    const context = contextRef.current;
    const selection = { team: refOf(choice.team), projectKey: choice.probe.projectKey, requestToken: choice.requestToken, probeFingerprint: choice.probe.fingerprint };
    try {
      if (context.sessionKey && !context.sessionKey.startsWith('new-session-')) {
        const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_select', sessionKey: context.sessionKey, storageProjectKey: context.storageProjectKey, ...selection });
        if (contextRef.current.sessionKey !== context.sessionKey || contextRef.current.storageProjectKey !== context.storageProjectKey) return;
        publishActivation(view.activation); setHistory(view.history || (activation && activation.id !== view.activation?.id ? [activation, ...history] : history)); setDraft(null);
      } else {
        const nextDraft = { team: choice.team, selection, sessionKey: `web:s_${newRequestToken()}` };
        setDraft(nextDraft); safeLocalStorage.setItem(draftKey(context.storageProjectKey), JSON.stringify(nextDraft));
      }
      setChoice(null); setError(null);
    } catch (cause) { setChoice(value => value ? { ...value, error: (cause as Error).message } : value); }
    finally { requestSequence.current += 1; changingRef.current = false; setChanging(false); }
  }, [choice, locked, activation, history, publishActivation]);
  const selectSolo = useCallback(async () => {
    if (locked) return false;
    const context = contextRef.current;
    requestSequence.current += 1;
    if (context.sessionKey && !context.sessionKey.startsWith('new-session-')) {
      changingRef.current = true; setChanging(true);
      try {
        const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_select', sessionKey: context.sessionKey, storageProjectKey: context.storageProjectKey, team: null, requestToken: newRequestToken() });
        if (contextRef.current.sessionKey !== context.sessionKey || contextRef.current.storageProjectKey !== context.storageProjectKey) return false;
        setHistory(view.history || (activation ? [activation, ...history] : history));
      } catch (cause) { setError((cause as Error).message); return false; }
      finally { requestSequence.current += 1; changingRef.current = false; setChanging(false); }
    }
    publishActivation(null); setDraft(null); safeLocalStorage.removeItem(draftKey(context.storageProjectKey)); setError(null); return true;
  }, [activation, history, locked, publishActivation]);
  const renewDraftRequest = useCallback(() => {
    setDraft(previous => {
      if (!previous) return previous;
      const next = { ...previous, selection: { ...previous.selection, requestToken: newRequestToken() } };
      safeLocalStorage.setItem(draftKey(contextRef.current.storageProjectKey), JSON.stringify(next));
      return next;
    });
  }, []);
  const stop = useCallback(async () => {
    const key = contextRef.current.sessionKey;
    if (!key || !activation) return;
    // Capture the identity at click time. A retry must never target a newer run.
    const identity = { activationId: activation.id, stopVersion: activation.stopVersion };
    requestSequence.current += 1;
    const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_stop', sessionKey: key, ...identity });
    if (contextRef.current.sessionKey === key && activationRef.current?.id === identity.activationId && activationRef.current.stopVersion <= (view.activation?.stopVersion ?? identity.stopVersion)) {
      requestSequence.current += 1;
      interactionVersion.current += 1;
      publishActivation(view.activation);
    }
  }, [activation, publishActivation]);
  const respondInteraction = useCallback(async (interaction: TeamHumanInteraction, response: {
    decision?: 'allow' | 'deny' | 'approve' | 'decline' | 'cancel'; answer?: unknown; reason?: string;
  }) => {
    const key = contextRef.current.sessionKey;
    const current = activationRef.current;
    if (!key || !current || current.id !== interaction.activationId || current.stopVersion !== interaction.stopVersion || key !== interaction.sessionKey) throw new Error(t('teamInteractions.sessionUnavailable'));
    const result = await teamCommand<TeamRuntimeInteractionResponse>({ action: 'runtime_interaction_respond', sessionKey: key,
      activationId: interaction.activationId, stopVersion: interaction.stopVersion,
      participantId: interaction.participantId, interactionId: interaction.id,
      requestId: interaction.requestId, kind: interaction.kind, ...response });
    // A durable response can be rejected without an HTTP error when the
    // in-process waiter has already expired.  Surface that outcome while the
    // ledger item is still pending so the panel offers a retry and does not
    // imply that the Teammate received the decision.
    if (result?.delivered === false && result?.interaction?.status === 'pending') {
      throw new Error(t('teamInteractions.connectionLost'));
    }
    const latest = activationRef.current;
    const resolved = result.interaction;
    if (contextRef.current.sessionKey !== key || latest?.id !== interaction.activationId || latest.stopVersion !== interaction.stopVersion) return;
    if (resolved.sessionKey !== key || resolved.activationId !== interaction.activationId || resolved.participantId !== interaction.participantId || resolved.requestId !== interaction.requestId || resolved.id !== interaction.id || resolved.stopVersion !== interaction.stopVersion || resolved.kind !== interaction.kind) throw new Error(t('teamInteractions.connectionLost'));
    interactionVersion.current += 1;
    publishActivation({ ...latest, interactions: [...interactionsRef.current.filter(item => item.id !== resolved.id), resolved] });
    await refresh();
  }, [refresh, publishActivation, t]);
  return { teams, catalogLoading, catalogError, reloadCatalog: catalog, activation, history, continuationPaused, draft, selectedTeam: activation?.team || draft?.team || null,
    interactions, respondInteraction,
    teamSelection: draft?.selection, teamDraftSessionId: draft?.sessionKey, teamActivationId: activation?.id ?? null, teamStopVersion: activation?.stopVersion, renewDraftRequest, loading, error, refresh,
    ready: !loading && !error && !changing && !choice && activation?.status !== 'stopping', locked, changing, choice, selectTeam, selectSolo, confirmChoice, cancelChoice,
    changeChoiceProject: (projectKey: string) => { if (choice && !changing) void probe({ ...choice, projectKey, requestToken: newRequestToken() }); },
    retryProbe: () => { if (choice) void probe(choice); },
    registeredProjects: projects.filter(item => !isGeneralProject(item)), projectIsFixed: Boolean(project && !isGeneralProject(project)),
    panelOpen, setPanelOpen, working: hasTeamWork(activation), stop };
}
export type TeamModeState = ReturnType<typeof useTeamMode>;
