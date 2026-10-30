import type { Project } from '../../types/app';
import { newRequestToken, refOf, type AgentProfile, type ProfileRef, type ProfileRole, type TeamConfig, type TeamLibrary } from './api';
import type { TeamDraft } from './drafts';
import { Dialog, ErrorBox, Field, ProjectOptions } from './Shared';
import { useTeamText } from './text';

type Props = { draft: TeamDraft; library: TeamLibrary; projects: Project[]; busy: boolean; error: string | null; onChange: (draft: TeamDraft) => void; onSave: () => void; onClose: () => void; onNewProfile: (role: ProfileRole) => void; onForkProfile: (profile: AgentProfile) => void; onCreateProject: () => void };
export function TeamEditor({ draft, library, projects, busy, error, onChange, onSave, onClose, onNewProfile, onForkProfile, onCreateProject }: Props) {
  const t = useTeamText(); const config = draft.config;
  const locked = busy || Boolean(draft.submitted);
  const update = (patch: Partial<TeamConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const profiles = library.profiles;
  const findProfile = (ref: ProfileRef) => profiles.find(profile => profile.id === ref.id);
  const member = (ref: ProfileRef) => {
    const profile = findProfile(ref);
    return <div className="team-member-row" key={ref.id}><div className="team-member-title"><div><strong>{profile?.config.displayName || t('missingRef')}</strong></div><div className="team-actions">{profile && <button type="button" className="team-button" disabled={locked} onClick={() => onForkProfile(profile)}>{t('forkInline')}</button>}</div></div>{profile && <p className="team-muted">{profile.config.description}</p>}</div>;
  };
  const leaderOptions = [...profiles.filter(profile => profile.role === 'leader')];
  const selectedLeader = findProfile(config.leader);
  if (selectedLeader && !leaderOptions.some(p => p.id === selectedLeader.id)) leaderOptions.push(selectedLeader);
  const teammateOptions = [...profiles.filter(profile => profile.role === 'teammate')];
  for (const ref of config.teammates) { const selected = findProfile(ref); if (selected && !teammateOptions.some(profile => profile.id === selected.id)) teammateOptions.push(selected); }
  return <>
    <Dialog title={draft.id ? t('edit') + ' Team' : t('newTeam')} busy={busy} onClose={onClose} footer={<>{draft.submitted && <button className="team-button" type="button" disabled={busy} onClick={() => onChange({ ...draft, submitted: false, requestToken: newRequestToken() })}>{t('newAttempt')}</button>}<button className="team-button" type="button" disabled={busy} onClick={onClose}>{t('discard')}</button><button className="team-button primary" type="submit" form="team-definition-form" disabled={busy}>{busy ? t('saving') : draft.submitted ? t('retry') : t('save')}</button></>}>
      <form id="team-definition-form" className="team-fields" onSubmit={e => { e.preventDefault(); onSave(); }}>
        <ErrorBox error={error}/>
        <Field label={t('name')}><input className="team-input" required value={config.displayName} maxLength={200} disabled={locked} onChange={e => update({ displayName: e.target.value })}/></Field>
        <Field label={t('description')}><input className="team-input" value={config.description} disabled={locked} onChange={e => update({ description: e.target.value })}/></Field>
        <Field label={t('instructions')} hint={t('instructionsHelp')}><textarea className="team-input" rows={3} value={config.instructions} disabled={locked} onChange={e => update({ instructions: e.target.value })}/></Field>
        <section className="team-section"><div className="team-topbar"><h3>{t('leader')}</h3><button type="button" className="team-button" disabled={locked} onClick={() => onNewProfile('leader')}>{t('createInline')} Leader</button></div>
          <select aria-label={t('leader')} required className="team-input" value={config.leader.id} disabled={locked} onChange={e => { const chosen = profiles.find(profile => profile.id === e.target.value); update({ leader: chosen ? refOf(chosen) : { id: '' } }); }}><option value="">{t('selectLeader')}</option>{leaderOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.config.displayName} · {profile.config.description}</option>)}</select>
          {config.leader.id && member(config.leader)}
        </section>
        <section className="team-section"><div className="team-topbar"><h3>{t('selectTeammates')}</h3><button type="button" className="team-button" disabled={locked} onClick={() => onNewProfile('teammate')}>{t('createInline')} Teammate</button></div>
          {teammateOptions.map(profile => { const ref = config.teammates.find(item => item.id === profile.id); return <div key={profile.id}><label className="team-check"><input type="checkbox" checked={Boolean(ref)} disabled={locked} onChange={e => update({ teammates: e.target.checked ? [...config.teammates, refOf(profile)] : config.teammates.filter(item => item.id !== profile.id) })}/>{profile.config.displayName}</label>{ref && member(ref)}</div>; })}
          {teammateOptions.length === 0 && <p className="team-muted">{t('emptyProfiles')}</p>}
          <p className="team-muted">{t('latest')}</p>
        </section>
        <Field label={t('defaultWorkspace')} hint={t('workspacesShared')}><select className="team-input" value={config.defaultProjectKey || ''} disabled={locked} onChange={e => update({ defaultProjectKey: e.target.value || null })}><option value="">{t('noDefaultWorkspace')}</option><ProjectOptions projects={projects} selected={config.defaultProjectKey}/></select></Field>
        {projects.length === 0 && <div className="team-notice">{t('projectMissing')} <button type="button" className="team-button" onClick={onCreateProject}>{t('createProject')}</button></div>}
        <p className="team-muted">{t('draftNotice')}</p><p className="team-id">{draft.id ? `${t('generatedId')}: ${draft.id}` : t('idHelp')}</p>
      </form>
    </Dialog>
  </>;
}
