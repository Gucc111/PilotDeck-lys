import { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { Loader2, RefreshCw, Users } from 'lucide-react';
import type { TeamModeState } from './useTeamMode';
import type { TeamRuntimeActivation } from '../../../../src/team/runtimeTypes';
import TeamInteractionPanel from './TeamInteractionPanel';
import { TeamDialog } from './TeamDialog';
export { TeamDialog } from './TeamDialog';
import './TeamMode.css';

/** Runtime cleanup keys identify executions, not profile IDs. */
export function cleanupTarget(activation: TeamRuntimeActivation, key: string) {
  const participant = key === 'leader'
    ? activation.participants.find(item => item.role === 'leader')
    : activation.participants.find(item => key === item.id || key.startsWith(`${activation.id}:${item.id}:`));
  if (participant) return { participantId: participant.id, label: `${participant.role === 'leader' ? 'Leader' : 'Teammate'} · ${participant.profile.config.displayName}` };
  if (key === `${activation.id}:notifications` || key.startsWith(`${activation.id}:notifications:`)) return { translationKey: 'teamMode.cleanupNotifications' };
  if (key === 'final resource cleanup') return { translationKey: 'teamMode.cleanupResources' };
  return { translationKey: 'teamMode.cleanupExecution' };
}

export default function TeamModeControls({ mode, onCreateProject }: { mode: TeamModeState; onCreateProject?: () => void }) {
  const { t } = useTranslation('chat');
  // TeamModeControls is normally rendered inside the app Router, but keeping
  // this context optional preserves the standalone component tests and makes
  // the status strip safe to render in an embedded host.  The browser-history
  // fallback still exposes a usable URL when no Router is present.
  const navigation = useContext(UNSAFE_NavigationContext);
  const { choice, changing, locked, confirmChoice } = mode;
  const choiceIsClean = Boolean(choice?.probe?.compatible && !choice.checking && !choice.probe.issues.length);
  const choiceNeedsConfirmation = Boolean(choice && !choice.checking && (choice.error || !choice.probe?.compatible || choice.probe.issues.length));
  useEffect(() => {
    if (!choiceIsClean || changing || locked) return;
    void confirmChoice();
  }, [choiceIsClean, changing, locked, confirmChoice]);
  const [viewedActivationId, setViewedActivationId] = useState<string | null>(null);
  const [interactionPanelOpen, setInteractionPanelOpen] = useState(false);
  const activation = mode.history.find(item => item.id === viewedActivationId) || mode.activation || mode.history[0] || null;
  const panelTeam = activation?.team || mode.selectedTeam;
  const panelVersions = [...(mode.activation ? [mode.activation] : []), ...mode.history];
  const closePanel = useCallback(() => mode.setPanelOpen(false), [mode.setPanelOpen]);
  const workStatus = (status: string) => t(`teamMode.status.${status}`, { defaultValue: status });
  const interactionPanelKey = mode.activation?.id ? `pilotdeck:team-interaction-panel:${mode.activation.id}` : null;
  useEffect(() => {
    setInteractionPanelOpen(false);
    if (!interactionPanelKey || typeof window === 'undefined') return;
    try {
      if (window.sessionStorage.getItem(interactionPanelKey) === 'open') setInteractionPanelOpen(true);
    } catch { /* sessionStorage is optional in embedded hosts */ }
  }, [interactionPanelKey]);
  const openInteractionPanel = useCallback(() => {
    setInteractionPanelOpen(true);
    if (interactionPanelKey && typeof window !== 'undefined') {
      try { window.sessionStorage.setItem(interactionPanelKey, 'open'); } catch { /* optional */ }
    }
    void mode.refresh();
  }, [interactionPanelKey, mode.refresh]);
  const closeInteractionPanel = useCallback(() => {
    setInteractionPanelOpen(false);
    if (interactionPanelKey && typeof window !== 'undefined') {
      try { window.sessionStorage.removeItem(interactionPanelKey); } catch { /* optional */ }
    }
    void mode.refresh();
  }, [interactionPanelKey, mode.refresh]);
  const openParticipantChat = useCallback((participantId: string) => {
    const current = mode.activation;
    if (!current) return;
    if (interactionPanelKey && typeof window !== 'undefined') {
      try { window.sessionStorage.setItem(interactionPanelKey, 'open'); } catch { /* optional */ }
    }
    const routePath = current.participants.find(item => item.id === participantId)?.role === 'leader'
      ? `/session/${encodeURIComponent(current.sessionKey)}`
      : `/team/${encodeURIComponent(current.sessionKey)}/${encodeURIComponent(current.id)}/teammate/${encodeURIComponent(participantId)}`;
    if (navigation?.navigator && typeof navigation.navigator.push === 'function') {
      // `navigator.push` bypasses useNavigate's basename handling, so apply
      // the Router basename explicitly for desktop/web deployments mounted
      // below a sub-path.
      navigation.navigator.push(`${(navigation.basename || '').replace(/\/$/, '')}${routePath}`);
    } else if (typeof window !== 'undefined') {
      window.history.pushState({}, '', routePath);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [mode.activation, navigation, interactionPanelKey]);
  return <>
    {(mode.selectedTeam || mode.history.length > 0 || mode.loading || mode.error) && <div className="team-mode-strip" aria-live="polite">
      <Users size={14}/><span className="team-mode-strip-name">{mode.selectedTeam?.config.displayName || (mode.history.length ? t('teamMode.history') : t('teamMode.loading'))}</span>
      <span>{!mode.selectedTeam && mode.history.length ? '' : mode.loading ? t('teamMode.loading') : mode.activation?.status === 'stopping' ? t('teamMode.stopping') : mode.activation?.stopReason === 'restart' && mode.activation.status === 'stopped' ? t('teamMode.restartInterrupted') : mode.working ? t('teamMode.working') : mode.activation?.status === 'stopped' ? t('teamMode.stopped') : t('teamMode.ready')}</span>
      {(mode.selectedTeam || mode.history.length > 0) && <button type="button" onClick={() => { mode.setPanelOpen(true); void mode.refresh(); }}>{t('teamMode.details')}</button>}
      {(mode.selectedTeam || mode.history.length > 0) && <button type="button" onClick={openInteractionPanel} aria-label={t('teamInteractions.title')}>{t('teamInteractions.title')}{(mode.interactions || []).filter(item => item.status === 'pending').length ? ` · ${(mode.interactions || []).filter(item => item.status === 'pending').length}` : ''}</button>}
      {mode.error && <div role="alert" className="team-mode-error">{mode.error}<button type="button" onClick={() => void mode.refresh()}>{t('teamMode.retry')}</button></div>}
    </div>}
    {choiceNeedsConfirmation && choice && <TeamDialog title={t('teamMode.enter', { name: choice.team.config.displayName })} onClose={mode.cancelChoice}>
      <div className="team-mode-body">
        {!mode.registeredProjects.length && <div className="team-mode-warning"><p>{t('teamMode.noProjects')}</p>{onCreateProject && <button type="button" onClick={() => { mode.cancelChoice(); onCreateProject(); }}>{t('teamMode.registerProject')}</button>}</div>}
        <div className="team-mode-roster"><strong>Leader · {choice.team.leader.config.displayName}</strong><span>{choice.team.teammates.map(item => item.config.displayName).join(' · ')}</span></div>
        {choice.checking && <p role="status" className="team-mode-inline"><Loader2 size={14} className="animate-spin"/>{t('teamMode.checking')}</p>}
        {choice.probe?.issues.map((issue, index) => <div key={`${issue.code}-${index}`} className={issue.severity === 'error' ? 'team-mode-error' : 'team-mode-warning'}>{issue.message}</div>)}
        {choice.error && <div role="alert" className="team-mode-error">{choice.error}<button type="button" onClick={mode.retryProbe}>{t('teamMode.retry')}</button></div>}
        {choice.probe?.compatible && <p className="team-mode-muted">{choice.probe.issues.some(issue => issue.severity === 'warning') ? t('teamMode.warningConsent') : t('teamMode.compatible')}</p>}
      </div>
      <div className="team-mode-footer"><button type="button" disabled={mode.changing} onClick={mode.cancelChoice}>{t('teamMode.cancel')}</button><button type="button" className="team-mode-primary" disabled={!choice.probe?.compatible || choice.checking || mode.changing || mode.locked} onClick={() => void mode.confirmChoice()}>{mode.changing ? t('teamMode.switching') : choice.probe?.issues.some(issue => issue.severity === 'warning') ? t('teamMode.confirmWarnings') : t('teamMode.useTeam')}</button></div>
    </TeamDialog>}
    {mode.panelOpen && panelTeam && <TeamDialog title={panelTeam.config.displayName} onClose={closePanel} side>
      <div className="team-mode-body">
        {panelVersions.length > 1 || (!mode.selectedTeam && panelVersions.length) ? <label className="team-mode-label">{t('teamMode.history')}<select value={activation?.id || ''} onChange={event => setViewedActivationId(event.target.value)}>{panelVersions.map(item => <option key={item.id} value={item.id}>{item.team.config.displayName} · {new Date(item.createdAt).toLocaleString()} · {item.id === mode.activation?.id ? t('teamMode.current') : t('teamMode.previous')}</option>)}</select></label> : null}
        <div className="team-mode-inline"><span>{t('teamMode.latestConfiguration', { defaultValue: 'Latest saved configuration' })}</span><button type="button" onClick={() => void mode.refresh()} aria-label={t('teamMode.refresh')}><RefreshCw size={15}/></button></div>
        <h3>{t('teamMode.members')}</h3>
        {(activation?.participants || [panelTeam.leader, ...panelTeam.teammates].map(profile => ({ id: profile.id, profile, role: profile.role, model: profile.config.model, capabilities: profile.config.capabilities, projectKey: profile.config.workspace.mode === 'fixed' ? profile.config.workspace.projectKey : mode.draft?.selection.projectKey }))).map(participant => {
          const activeTurn = activation?.turns?.find(turn => turn.participantId === participant.id && ['preparing', 'running', 'waiting_approval'].includes(turn.status));
          return <article className="team-mode-card" key={participant.id}><strong>{participant.profile.config.displayName}</strong><span className="team-mode-muted">{participant.role === 'leader' ? 'Leader' : 'Teammate'} · {activation?.status === 'stopping' && activation.cleanup?.pending.some(key => cleanupTarget(activation, key).participantId === participant.id) ? t('teamMode.stopping') : activeTurn ? workStatus(activeTurn.status) : t('teamMode.idle')}</span><span>{participant.model.mode === 'model' ? `${participant.model.provider}/${participant.model.model}` : t('teamMode.defaultModel')}</span><span className="team-mode-muted">{participant.projectKey}</span><details><summary>{t("teamMode.capabilities")}</summary><p className="team-mode-text">{[...(participant.capabilities?.tools || []), ...(participant.capabilities?.skills || []), ...(participant.capabilities?.mcpServers || [])].join(" · ") || t("teamMode.coordinationOnly")}</p></details></article>;
        })}
        {activation?.status === 'stopping' && <div role="status" className="team-mode-warning"><p>{t('teamMode.stoppingHelp')}</p>{activation.cleanup?.pending.map(key => { const target = cleanupTarget(activation, key); return <p key={key} className="team-mode-text">{target.label || t(target.translationKey!)}</p>; })}{activation.cleanup?.error && <p className="team-mode-error">{activation.cleanup.error}</p>}{activation.cleanup?.timedOut && <p>{t('teamMode.stopTimeout')}</p>}</div>}
      </div>
    </TeamDialog>}
    {interactionPanelOpen && panelTeam && <TeamInteractionPanel mode={mode} onClose={closeInteractionPanel} onViewChat={openParticipantChat} />}
  </>;
}
