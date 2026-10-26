import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, Users, X } from 'lucide-react';
import { projectDisplayName } from '../../lib/customNames';
import { workspaceKey } from '../team-library/api';
import type { TeamModeState } from './useTeamMode';
import type { TeamRuntimeActivation } from '../../../../src/team/runtimeTypes';
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

function TeamDialog({ title, onClose, children, side = false }: { title: string; onClose: () => void; children: React.ReactNode; side?: boolean }) {
  const { t } = useTranslation('chat');
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]');
        if (!items?.length) { event.preventDefault(); return; }
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return createPortal(<div className={`team-mode-overlay ${side ? 'team-mode-side' : ''}`} data-modal-overlay onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="team-mode-dialog">
      <div className="team-mode-header"><h2>{title}</h2><button type="button" onClick={onClose} aria-label={t("teamMode.close")}><X size={18}/></button></div>{children}
    </div>
  </div>, document.body);
}

export default function TeamModeControls({ mode, onCreateProject }: { mode: TeamModeState; onCreateProject?: () => void }) {
  const { t } = useTranslation('chat');
  const { choice } = mode;
  const [viewedActivationId, setViewedActivationId] = useState<string | null>(null);
  const activation = mode.history.find(item => item.id === viewedActivationId) || mode.activation || mode.history[0] || null;
  const panelTeam = activation?.team || mode.selectedTeam;
  const panelVersions = [...(mode.activation ? [mode.activation] : []), ...mode.history];
  const closePanel = useCallback(() => mode.setPanelOpen(false), [mode.setPanelOpen]);
  const memberName = (id: string) => activation?.participants.find(participant => participant.id === id)?.profile.config.displayName || id;
  const workStatus = (status: string) => t(`teamMode.status.${status}`, { defaultValue: status });
  return <>
    {(mode.selectedTeam || mode.history.length > 0 || mode.loading || mode.error) && <div className="team-mode-strip" aria-live="polite">
      <Users size={14}/><span className="team-mode-strip-name">{mode.selectedTeam?.config.displayName || (mode.history.length ? t('teamMode.history') : t('teamMode.loading'))}</span>
      <span>{!mode.selectedTeam && mode.history.length ? '' : mode.loading ? t('teamMode.loading') : mode.activation?.status === 'stopping' ? t('teamMode.stopping') : mode.activation?.stopReason === 'restart' && mode.activation.status === 'stopped' ? t('teamMode.restartInterrupted') : mode.working ? t('teamMode.working') : mode.activation?.status === 'stopped' ? t('teamMode.stopped') : t('teamMode.ready')}</span>
      {(mode.selectedTeam || mode.history.length > 0) && <button type="button" onClick={() => { mode.setPanelOpen(true); void mode.refresh(); }}>{t('teamMode.details')}</button>}
      {mode.continuationPaused && <div role="status" className="team-mode-warning">{t("teamMode.continuationPaused")}</div>}
      {mode.error && <div role="alert" className="team-mode-error">{mode.error}<button type="button" onClick={() => void mode.refresh()}>{t('teamMode.retry')}</button></div>}
    </div>}
    {choice && <TeamDialog title={t('teamMode.enter', { name: choice.team.config.displayName })} onClose={mode.cancelChoice}>
      <div className="team-mode-body">
        <p>{t('teamMode.enterHelp')}</p>
        <label className="team-mode-label">{t('teamMode.workspace')}
          <select value={choice.projectKey} disabled={mode.projectIsFixed || mode.changing} onChange={event => mode.changeChoiceProject(event.target.value)}>
            <option value="">{t('teamMode.chooseWorkspace')}</option>
            {mode.registeredProjects.map(project => <option key={workspaceKey(project)} value={workspaceKey(project)}>{projectDisplayName(project)}</option>)}
          </select>
        </label>
        {mode.projectIsFixed && <p className="team-mode-muted">{t('teamMode.fixedWorkspace')}</p>}
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
        <p>{t('teamMode.panelHelp')}</p>
        {panelVersions.length > 1 || (!mode.selectedTeam && panelVersions.length) ? <label className="team-mode-label">{t('teamMode.history')}<select value={activation?.id || ''} onChange={event => setViewedActivationId(event.target.value)}>{panelVersions.map(item => <option key={item.id} value={item.id}>{item.team.config.displayName} · {new Date(item.createdAt).toLocaleString()} · {item.id === mode.activation?.id ? t('teamMode.current') : t('teamMode.previous')}</option>)}</select></label> : null}
        <div className="team-mode-inline"><span>{t('teamMode.revision', { revision: panelTeam.revision })}</span><button type="button" onClick={() => void mode.refresh()} aria-label={t('teamMode.refresh')}><RefreshCw size={15}/></button></div>
        <h3>{t('teamMode.members')}</h3>
        {(activation?.participants || [panelTeam.leader, ...panelTeam.teammates].map(profile => ({ id: profile.id, profile, role: profile.role, model: profile.config.model, capabilities: profile.config.capabilities, projectKey: profile.config.workspace.mode === 'fixed' ? profile.config.workspace.projectKey : mode.draft?.selection.projectKey }))).map(participant => {
          const activeWork = activation?.works.find(work => work.participantId === participant.id && ['running', 'waiting_information', 'waiting_approval', 'queued'].includes(work.status));
          return <article className="team-mode-card" key={participant.id}><strong>{participant.profile.config.displayName}</strong><span className="team-mode-muted">{participant.role === 'leader' ? 'Leader' : 'Teammate'} · {activation?.status === 'stopping' && activation.cleanup?.pending.some(key => cleanupTarget(activation, key).participantId === participant.id) ? t('teamMode.stopping') : activeWork ? workStatus(activeWork.status) : t('teamMode.idle')}</span><span>{participant.model.mode === 'model' ? `${participant.model.provider}/${participant.model.model}` : t('teamMode.defaultModel')}</span><span className="team-mode-muted">{participant.projectKey}</span><details><summary>{t("teamMode.capabilities")}</summary><p className="team-mode-text">{[...(participant.capabilities?.tools || []), ...(participant.capabilities?.skills || []), ...(participant.capabilities?.mcpServers || [])].join(" · ") || t("teamMode.coordinationOnly")}</p></details></article>;
        })}
        <h3>{t('teamMode.tasks')}</h3>
        {!activation?.works.length && <p className="team-mode-muted">{t('teamMode.noTasks')}</p>}
        {activation?.works.map(work => <article className="team-mode-card" key={work.id}><div className="team-mode-inline"><strong>{memberName(work.participantId)}</strong><span>{workStatus(work.status)}</span></div><p>{work.task}</p>{work.result && <details><summary>{t('teamMode.result')}</summary><p className="team-mode-text">{work.result}</p></details>}{work.error && <p className="team-mode-error">{work.error}</p>}</article>)}
        <h3>{t('teamMode.messages')}</h3>
        {!activation?.messages.length && <p className="team-mode-muted">{t('teamMode.noMessages')}</p>}
        {activation?.messages.map(message => <article className="team-mode-card" key={message.id}><strong>{memberName(message.senderId)} → {memberName(message.recipientId)}</strong>{message.intendedRecipientId !== message.recipientId && <span className="team-mode-muted">{t(activation.messages.some(relay => relay.relayOf === message.id) ? 'teamMode.relayed' : 'teamMode.awaitingRelay', { name: memberName(message.intendedRecipientId) })}</span>}<span className="team-mode-muted">{workStatus(message.status)}</span><p className="team-mode-text">{message.text}</p></article>)}
        {activation?.status === 'stopping' && <div role="status" className="team-mode-warning"><p>{t('teamMode.stoppingHelp')}</p>{activation.cleanup?.pending.map(key => { const target = cleanupTarget(activation, key); return <p key={key} className="team-mode-text">{target.label || t(target.translationKey!)}</p>; })}{activation.cleanup?.error && <p className="team-mode-error">{activation.cleanup.error}</p>}{activation.cleanup?.timedOut && <p>{t('teamMode.stopTimeout')}</p>}</div>}
        {activation?.status === 'stopped' && <p className="team-mode-warning">{t('teamMode.stopHelp')}</p>}
      </div>
    </TeamDialog>}
  </>;
}
