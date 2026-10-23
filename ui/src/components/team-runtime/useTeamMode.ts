import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../../types/app';
import { isGeneralProject } from '../app-shell/appShellSelection';
import { teamCommand, newRequestToken, refOf, workspaceKey, type TeamDefinition, type TeamLibrary } from '../team-library/api';
import { safeLocalStorage } from '../chat/utils/chatStorage';
import type { TeamExecutionSelection, TeamRuntimeActivation, TeamRuntimeProbe, TeamRuntimeView } from '../../../../src/team/runtimeTypes';

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
  const [teams, setTeams] = useState<TeamDefinition[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activation, setActivation] = useState<TeamRuntimeActivation | null>(null);
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
    try {
      const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_get', sessionKey: key });
      if (sequence !== requestSequence.current || contextRef.current.sessionKey !== key) return;
      setActivation(view.activation?.status === 'closed' ? null : view.activation);
      setHistory(view.history || []); setContinuationPaused(view.continuationPaused);
      if (view.activation) { setDraft(null); safeLocalStorage.removeItem(draftKey(contextRef.current.storageProjectKey)); }
      setError(null); setLoading(false);
    } catch (cause) {
      if (sequence !== requestSequence.current || contextRef.current.sessionKey !== key) return;
      setError((cause as Error).message); setLoading(false);
    }
  }, []);
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
    setActivation(null); setHistory([]); setContinuationPaused(undefined);
    if (!sessionKey || sessionKey.startsWith('new-session-')) { setLoading(false); return; }
    setLoading(true); void refresh();
  }, [sessionKey, storageProjectKey, refresh]);
  useEffect(() => {
    if (!sessionKey || sessionKey.startsWith('new-session-')) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, activation || busy ? 2000 : 10000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [sessionKey, activation?.id, busy, refresh]);

  const locked = busy || hasTeamWork(activation) || changing || loading || Boolean(error);
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
        setActivation(view.activation); setHistory(view.history || (activation && activation.id !== view.activation?.id ? [activation, ...history] : history)); setDraft(null);
      } else {
        const nextDraft = { team: choice.team, selection, sessionKey: `web:s_${newRequestToken()}` };
        setDraft(nextDraft); safeLocalStorage.setItem(draftKey(context.storageProjectKey), JSON.stringify(nextDraft));
      }
      setChoice(null); setError(null);
    } catch (cause) { setChoice(value => value ? { ...value, error: (cause as Error).message } : value); }
    finally { requestSequence.current += 1; changingRef.current = false; setChanging(false); }
  }, [choice, locked, activation, history]);
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
    setActivation(null); setDraft(null); safeLocalStorage.removeItem(draftKey(context.storageProjectKey)); setError(null); return true;
  }, [activation, history, locked]);
  const stop = useCallback(async () => {
    const key = contextRef.current.sessionKey;
    if (!key) return;
    const view = await teamCommand<TeamRuntimeView>({ action: 'runtime_stop', sessionKey: key });
    if (contextRef.current.sessionKey === key) setActivation(view.activation);
  }, []);
  return { teams, catalogLoading, catalogError, reloadCatalog: catalog, activation, history, continuationPaused, draft, selectedTeam: activation?.team || draft?.team || null,
    teamSelection: draft?.selection, teamDraftSessionId: draft?.sessionKey, teamActivationId: activation?.id ?? null, loading, error, refresh,
    ready: !loading && !error && !changing && !choice, locked, changing, choice, selectTeam, selectSolo, confirmChoice, cancelChoice,
    changeChoiceProject: (projectKey: string) => { if (choice && !changing) void probe({ ...choice, projectKey, requestToken: newRequestToken() }); },
    retryProbe: () => { if (choice) void probe(choice); },
    registeredProjects: projects.filter(item => !isGeneralProject(item)), projectIsFixed: Boolean(project && !isGeneralProject(project)),
    panelOpen, setPanelOpen, working: hasTeamWork(activation), stop };
}
export type TeamModeState = ReturnType<typeof useTeamMode>;
