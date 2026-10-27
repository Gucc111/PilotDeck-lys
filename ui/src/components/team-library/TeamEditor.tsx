import { useState } from 'react';
import type { Project } from '../../types/app';
import { newRequestToken, refOf, type AgentProfile, type ProfileRef, type ProfileRole, type TeamConfig, type TeamLibrary } from './api';
import type { TeamDraft } from './drafts';
import { Dialog, ErrorBox, Field, ProjectOptions } from './Shared';
import { useTeamText } from './text';

type Props = { draft: TeamDraft; library: TeamLibrary; projects: Project[]; busy: boolean; error: string | null; onChange: (draft: TeamDraft) => void; onSave: () => void; onClose: () => void; onNewProfile: (role: ProfileRole) => void; onForkProfile: (profile: AgentProfile) => void; onCreateProject: () => void };
export function TeamEditor({ draft, library, projects, busy, error, onChange, onSave, onClose, onNewProfile, onForkProfile, onCreateProject }: Props) {
  const t = useTeamText(); const config = draft.config; const [comparison, setComparison] = useState<{ old: AgentProfile; latest: AgentProfile } | null>(null);
  const locked = busy || Boolean(draft.submitted);
  const comparisonFields = (profile: AgentProfile) => ({
    [t('name')]: profile.config.displayName,
    [t('description')]: profile.config.description,
    [t('prompt')]: profile.config.systemPrompt,
    [t('model')]: profile.config.model.mode === 'default' ? t('defaultModel') : `${profile.config.model.provider}/${profile.config.model.model}`,
    [t('workspace')]: profile.config.workspace.mode === 'team' ? t('inheritedWorkspace') : profile.config.workspace.projectKey,
    [t('permission')]: t(profile.config.permissionMode === 'default' ? 'permissionDefault' : profile.config.permissionMode === 'plan' ? 'permissionPlan' : 'permissionBypass'),
    [t('tools')]: profile.config.capabilities.tools.join(', '),
    [t('skills')]: profile.config.capabilities.skills.join(', '),
    [t('mcp')]: profile.config.capabilities.mcpServers.join(', '),
    [t('optional')]: profile.config.optionalCapabilities.map(item => `${item.kind}: ${item.name}`).join(', '),
    [t('reasoning')]: profile.config.model.mode === 'model' ? String(profile.config.model.reasoning ?? t('modelDefaultParameter')) : t('modelDefaultParameter'),
    [t('speed')]: profile.config.model.mode === 'model' ? String(profile.config.model.speed ?? t('modelDefaultParameter')) : t('modelDefaultParameter'),
  });
  const update = (patch: Partial<TeamConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const profiles = library.profiles;
  const savedTeam = library.teams.find(team => team.id === draft.id);
  const frozen = savedTeam ? [savedTeam.leader, ...savedTeam.teammates] : [];
  const findProfile = (ref: ProfileRef) => frozen.find(profile => profile.id === ref.id && profile.revision === ref.revision) || profiles.find(profile => profile.id === ref.id && profile.revision === ref.revision);
  const adopt = (profile: AgentProfile) => profile.role === 'leader' ? update({ leader: refOf(profile) }) : update({ teammates: config.teammates.map(ref => ref.id === profile.id ? refOf(profile) : ref) });
  const member = (ref: ProfileRef) => {
    const old = findProfile(ref); const latest = profiles.find(profile => profile.id === ref.id); const hasUpdate = latest && latest.revision > ref.revision;
    return <div className="team-member-row" key={ref.id}><div className="team-member-title"><div><strong>{old?.config.displayName || latest?.config.displayName || t('missingRef')}</strong> <span className="team-badge">v{ref.revision}</span></div><div className="team-actions">{hasUpdate && <><span className="team-badge">{t('updates')}</span>{old && <button type="button" className="team-button" onClick={() => setComparison({ old, latest })}>{t('compare')}</button>}<button type="button" className="team-button" disabled={locked || latest.archived} onClick={() => adopt(latest)}>{t('adopt')}</button></>}{old && <button type="button" className="team-button" disabled={locked} onClick={() => onForkProfile(old)}>{t('forkInline')}</button>}</div></div>{old && <p className="team-muted">{old.config.description}</p>}</div>;
  };
  const leaderOptions = [...profiles.filter(profile => profile.role === 'leader' && !profile.archived)];
  const selectedLeader = findProfile(config.leader);
  if (selectedLeader && !leaderOptions.some(p => p.id === selectedLeader.id)) leaderOptions.push(selectedLeader);
  const teammateOptions = [...profiles.filter(profile => profile.role === 'teammate' && !profile.archived)];
  for (const ref of config.teammates) { const selected = findProfile(ref); if (selected && !teammateOptions.some(profile => profile.id === selected.id)) teammateOptions.push(selected); }
  return <>
    <Dialog title={draft.id ? t('edit') + ' Team' : t('newTeam')} busy={busy} onClose={onClose} footer={<>{draft.submitted && <button className="team-button" type="button" disabled={busy} onClick={() => onChange({ ...draft, submitted: false, requestToken: newRequestToken() })}>{t('newAttempt')}</button>}<button className="team-button" type="button" disabled={busy} onClick={onClose}>{t('discard')}</button><button className="team-button primary" type="submit" form="team-definition-form" disabled={busy}>{busy ? t('saving') : draft.submitted ? t('retry') : t('save')}</button></>}>
      <form id="team-definition-form" className="team-fields" onSubmit={e => { e.preventDefault(); onSave(); }}>
        <ErrorBox error={error}/>
        <Field label={t('name')}><input className="team-input" required value={config.displayName} maxLength={200} disabled={locked} onChange={e => update({ displayName: e.target.value })}/></Field>
        <Field label={t('description')}><input className="team-input" value={config.description} disabled={locked} onChange={e => update({ description: e.target.value })}/></Field>
        <Field label={t('instructions')} hint={t('instructionsHelp')}><textarea className="team-input" rows={3} value={config.instructions} disabled={locked} onChange={e => update({ instructions: e.target.value })}/></Field>
        <section className="team-section"><div className="team-topbar"><h3>{t('leader')}</h3><button type="button" className="team-button" disabled={locked} onClick={() => onNewProfile('leader')}>{t('createInline')} Leader</button></div>
          <select aria-label={t('leader')} required className="team-input" value={config.leader.id} disabled={locked} onChange={e => { const chosen = profiles.find(profile => profile.id === e.target.value); update({ leader: chosen ? refOf(chosen) : { id: '', revision: 1 } }); }}><option value="">{t('selectLeader')}</option>{leaderOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.config.displayName} · {profile.config.description}{profile.archived ? ` (${t('archived')})` : ''}</option>)}</select>
          {config.leader.id && member(config.leader)}
        </section>
        <section className="team-section"><div className="team-topbar"><h3>{t('selectTeammates')}</h3><button type="button" className="team-button" disabled={locked} onClick={() => onNewProfile('teammate')}>{t('createInline')} Teammate</button></div>
          {teammateOptions.map(profile => { const ref = config.teammates.find(item => item.id === profile.id); return <div key={profile.id}><label className="team-check"><input type="checkbox" checked={Boolean(ref)} disabled={locked} onChange={e => update({ teammates: e.target.checked ? [...config.teammates, refOf(profile)] : config.teammates.filter(item => item.id !== profile.id) })}/>{profile.config.displayName}{profile.archived && <span className="team-badge">{t('archived')}</span>}</label>{ref && member(ref)}</div>; })}
          {teammateOptions.length === 0 && <p className="team-muted">{t('emptyProfiles')}</p>}
          <p className="team-muted">{t('frozen')} {t('syncHelp')}</p>
        </section>
        <Field label={t('defaultWorkspace')} hint={t('workspacesShared')}><select className="team-input" value={config.defaultProjectKey || ''} disabled={locked} onChange={e => update({ defaultProjectKey: e.target.value || null })}><option value="">{t('noDefaultWorkspace')}</option><ProjectOptions projects={projects} selected={config.defaultProjectKey}/></select></Field>
        {projects.length === 0 && <div className="team-notice">{t('projectMissing')} <button type="button" className="team-button" onClick={onCreateProject}>{t('createProject')}</button></div>}
        <p className="team-muted">{t('draftNotice')}</p><p className="team-id">{draft.id ? `${t('generatedId')}: ${draft.id}` : t('idHelp')}</p>
      </form>
    </Dialog>
    {comparison && <Dialog title={t('compareTitle')} onClose={() => setComparison(null)} footer={<button className="team-button primary" type="button" disabled={locked || comparison.latest.archived} onClick={() => { adopt(comparison.latest); setComparison(null); }}>{t('adopt')}</button>}><div><div className="team-compare"><strong>{t('using')} · v{comparison.old.revision}</strong><strong>{t('latest')} · v{comparison.latest.revision}</strong></div>{Object.entries(comparisonFields(comparison.old)).map(([label, oldValue]) => { const nextValue = comparisonFields(comparison.latest)[label]; return <section key={label} className="team-section"><h3>{label} {oldValue !== nextValue && <span className="team-badge">{t('change')}</span>}</h3><div className="team-compare"><p className="team-value">{oldValue || '—'}</p><p className="team-value">{nextValue || '—'}</p></div></section>; })}</div></Dialog>}
  </>;
}
