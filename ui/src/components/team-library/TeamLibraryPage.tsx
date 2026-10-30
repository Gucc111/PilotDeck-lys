import { useCallback, useEffect, useState } from 'react';
import { Menu, Plus, RefreshCw, Users } from 'lucide-react';
import type { Project } from '../../types/app';
import type { ChatModelCatalogItem } from '../chat/hooks/useChatProviderState';
import { parseCatalogItem } from '../chat-v2/modelCapabilityOptions';
import { authenticatedFetch } from '../../utils/api';
import { newRequestToken, refOf, teamCommand, type AgentProfile, type ProfileRole, type TeamDefinition, type TeamLibrary } from './api';
import { newProfileDraft, newTeamDraft, readDrafts, saveDrafts, type LibraryDrafts } from './drafts';
import { ProfileEditor } from './ProfileEditor';
import { TeamEditor } from './TeamEditor';
import { Dialog, ErrorBox, Field, projectLabel } from './Shared';
import { useTeamText } from './text';
import './TeamLibrary.css';

type Props = { projects: Project[]; onCreateProject: () => void; onOpenSidebar?: () => void; sidebarCollapsed?: boolean };
type PendingAction = { kind: 'profile' | 'team'; item: AgentProfile | TeamDefinition; action: 'fork' | 'delete'; name: string; token: string };
const emptyLibrary: TeamLibrary = { profiles: [], teams: [] };
export default function TeamLibraryPage({ projects: rawProjects, onCreateProject, onOpenSidebar, sidebarCollapsed }: Props) {
  const t = useTeamText();
  const projects = rawProjects.filter(project => project.kind !== 'general' && project.name !== 'general');
  const [library, setLibrary] = useState<TeamLibrary>(emptyLibrary); const [models, setModels] = useState<ChatModelCatalogItem[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'teams' | 'leaders' | 'teammates'>('teams');
  const [drafts, setDrafts] = useState<LibraryDrafts>(readDrafts); const [restored] = useState(() => Boolean(readDrafts().profile || readDrafts().team));
  const [busy, setBusy] = useState(false); const [editorError, setEditorError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ kind: 'team' | 'profile'; id: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null); const [pendingError, setPendingError] = useState<string | null>(null);
  useEffect(() => { saveDrafts(drafts); }, [drafts]);
  const reload = useCallback(async () => { setLoading(true); setError(null); try { setLibrary(await teamCommand<TeamLibrary>({ action: 'library' })); } catch (err) { setError((err as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); let current = true; void authenticatedFetch('/api/models').then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data?.error?.message || t('noModel')); if (current) setModels((data.items || []).map(parseCatalogItem).filter(Boolean)); }).catch(() => { if (current) setModels([]); }); return () => { current = false; }; }, [reload]);
  const upsertProfile = (profile: AgentProfile) => setLibrary(value => ({ ...value, profiles: [...value.profiles.filter(item => item.id !== profile.id), profile] }));
  const upsertTeam = (team: TeamDefinition) => setLibrary(value => ({ ...value, teams: [...value.teams.filter(item => item.id !== team.id), team] }));
  const createProfile = (role: ProfileRole, addToTeam = false) => { setEditorError(null); setDrafts(value => ({ ...value, profile: newProfileDraft(role, addToTeam) })); };
  const editProfile = (profile: AgentProfile, addToTeam = false, replaceProfileId?: string) => { setDetail(null); setEditorError(null); setDrafts(value => ({ ...value, profile: { kind: 'profile', role: profile.role, id: profile.id, config: structuredClone(profile.config), requestToken: newRequestToken(), addToTeam, replaceProfileId } })); };
  const createTeam = () => { setEditorError(null); setDrafts(value => ({ ...value, team: newTeamDraft() })); };
  const editTeam = (team: TeamDefinition) => { setDetail(null); setEditorError(null); setDrafts(value => ({ ...value, team: { kind: 'team', id: team.id, config: structuredClone(team.config), requestToken: newRequestToken() } })); };
  const saveProfile = async () => {
    const draft = drafts.profile; if (!draft || busy) return;
    if (!draft.config.displayName.trim() || !draft.config.systemPrompt.trim()) { setEditorError(t(!draft.config.displayName.trim() ? 'nameRequired' : 'promptRequired')); return; }
    if (draft.config.model.mode !== 'model' || !draft.config.model.provider.trim() || !draft.config.model.model.trim()) { setEditorError(t('modelRequired')); return; }
    setBusy(true); setEditorError(null); setDrafts(value => ({ ...value, profile: { ...draft, submitted: true } }));
    try { const profile = await teamCommand<AgentProfile>({ action: 'profile_save', role: draft.role, config: draft.config, ...(draft.id ? { id: draft.id } : {}), requestToken: draft.requestToken }); upsertProfile(profile);
      setDrafts(value => { let team = value.team; if (draft.addToTeam && team) { const config = { ...team.config }; if (profile.role === 'leader') config.leader = refOf(profile); else config.teammates = [...config.teammates.filter(ref => ref.id !== profile.id && ref.id !== draft.replaceProfileId), refOf(profile)]; team = { ...team, config }; } return { ...value, profile: undefined, team }; }); setNotice(t(draft.addToTeam ? 'profileCreated' : 'saved'));
    } catch (err) { setEditorError((err as Error).message); } finally { setBusy(false); }
  };
  const saveTeam = async () => {
    const draft = drafts.team; if (!draft || busy) return;
    if (!draft.config.displayName.trim() || !draft.config.leader.id || !draft.config.teammates.length) { setEditorError(t(!draft.config.displayName.trim() ? 'nameRequired' : !draft.config.leader.id ? 'leaderRequired' : 'teammateRequired')); return; }
    setBusy(true); setEditorError(null); setDrafts(value => ({ ...value, team: { ...draft, submitted: true } }));
    try { const team = await teamCommand<TeamDefinition>({ action: 'team_save', config: draft.config, ...(draft.id ? { id: draft.id } : {}), requestToken: draft.requestToken }); upsertTeam(team); setDrafts(value => ({ ...value, team: undefined })); setDetail({ kind: 'team', id: team.id }); setNotice(t('saved')); } catch (err) { setEditorError((err as Error).message); } finally { setBusy(false); }
  };
  const requestAction = (kind: 'profile' | 'team', item: AgentProfile | TeamDefinition, action: 'fork' | 'delete') => { setPendingError(null); setPending({ kind, item, action, name: action === 'fork' ? `${item.config.displayName} (copy)` : item.config.displayName, token: newRequestToken() }); };
  const applyAction = async () => {
    if (!pending || busy) return; setBusy(true); setPendingError(null);
    try {
      if (pending.action === 'fork') {
        if (pending.kind === 'profile') { const profile = await teamCommand<AgentProfile>({ action: 'profile_fork', source: refOf(pending.item), displayName: pending.name, requestToken: pending.token }); upsertProfile(profile); editProfile(profile, Boolean(drafts.team), pending.item.id); }
        else { const team = await teamCommand<TeamDefinition>({ action: 'team_fork', source: refOf(pending.item), displayName: pending.name, requestToken: pending.token }); upsertTeam(team); editTeam(team); }
      } else if (pending.kind === 'profile') { await teamCommand({ action: 'profile_delete', id: pending.item.id, requestToken: pending.token }); setLibrary(value => ({ ...value, profiles: value.profiles.filter(item => item.id !== pending.item.id) })); }
      else { await teamCommand({ action: 'team_delete', id: pending.item.id, requestToken: pending.token }); setLibrary(value => ({ ...value, teams: value.teams.filter(item => item.id !== pending.item.id) })); }
      setPending(null);
    } catch (err) { setPendingError((err as Error).message); } finally { setBusy(false); }
  };
  const selectedTeam = detail?.kind === 'team' ? library.teams.find(item => item.id === detail.id) : undefined;
  const selectedProfile = detail?.kind === 'profile' ? library.profiles.find(item => item.id === detail.id) : undefined;
  const profiles = library.profiles.filter(item => item.role === (tab === 'leaders' ? 'leader' : 'teammate'));
  const teams = library.teams;
  const profileSummary = (profile: AgentProfile) => <><div className="team-person"><span className="team-avatar">{profile.role === 'leader' ? 'L' : 'T'}</span><div className="min-w-0"><strong>{profile.config.displayName}</strong><p className="team-muted">{profile.config.model.mode === 'default' ? t('defaultModel') : `${profile.config.model.provider}/${profile.config.model.model}`}</p></div></div><p className="team-muted">{profile.config.workspace.mode === 'team' ? t('inheritedWorkspace') : projectLabel(projects, profile.config.workspace.projectKey)}</p></>;
  return <div className="team-library"><div className="team-content">
    <header className="team-heading"><div className="team-actions">{sidebarCollapsed && <button type="button" className="team-button" onClick={onOpenSidebar} aria-label="Open sidebar"><Menu size={18}/></button>}<h1>{t('title')}</h1></div><button type="button" className="team-button" onClick={() => void reload()} disabled={loading} aria-label={t('refresh')}><RefreshCw size={16}/></button></header>
    <div className="team-tabs" role="tablist" aria-label={t('title')}>{(['teams', 'leaders', 'teammates'] as const).map(key => <button role="tab" aria-selected={tab === key} key={key} onClick={() => setTab(key)}>{t(key)}</button>)}</div>
    <ErrorBox error={error}/>{notice && <div className="team-notice" role="status">{notice}</div>}{restored && (drafts.profile || drafts.team) && <p className="team-muted">{t('draftRestored')}</p>}
    <div className="team-toolbar"><button className="team-button primary" onClick={() => tab === 'teams' ? createTeam() : createProfile(tab === 'leaders' ? 'leader' : 'teammate')}><Plus size={15}/>{t(tab === 'teams' ? 'newTeam' : tab === 'leaders' ? 'newLeader' : 'newTeammate')}</button></div>
    {loading && !library.teams.length && !library.profiles.length ? <p className="team-muted">{t('loading')}</p> : tab === 'teams' ? teams.length ? <div className="team-grid">{teams.map(team => <article className="team-card" key={team.id}><div className="team-actions"><Users size={17}/><h2>{team.config.displayName}</h2></div>{team.config.description && <p className="team-muted">{team.config.description}</p>}<div>{profileSummary(team.leader)}<p className="team-muted">{team.teammates.map(item => item.config.displayName).join(' · ')}</p></div><div className="team-actions"><button className="team-button" onClick={() => setDetail({ kind: 'team', id: team.id })}>{t('details')}</button></div></article>)}</div> : <div className="team-empty"><Users className="mx-auto mb-3" size={30}/><h2>{t('emptyTeams')}</h2><button className="team-button primary" onClick={createTeam}>{t('newTeam')}</button></div> : profiles.length ? <div className="team-grid">{profiles.map(profile => <article className="team-card" key={profile.id}><h2>{profile.config.displayName}</h2>{profile.config.description && <p className="team-muted">{profile.config.description}</p>}{profileSummary(profile)}<div className="team-actions"><button className="team-button" onClick={() => setDetail({ kind: 'profile', id: profile.id })}>{t('details')}</button><button className="team-button" onClick={() => editProfile(profile)}>{t('edit')}</button><button className="team-button" onClick={() => requestAction('profile', profile, 'fork')}>{t('fork')}</button></div></article>)}</div> : <div className="team-empty"><h2>{t('emptyProfiles')}</h2><button className="team-button primary" onClick={() => createProfile(tab === 'leaders' ? 'leader' : 'teammate')}>{t(tab === 'leaders' ? 'newLeader' : 'newTeammate')}</button></div>}
  </div>
  {selectedProfile && <Dialog title={selectedProfile.config.displayName} onClose={() => setDetail(null)} footer={<><button className="team-button" onClick={() => requestAction('profile', selectedProfile, 'delete')}>{t('delete')}</button><button className="team-button" onClick={() => requestAction('profile', selectedProfile, 'fork')}>{t('fork')}</button><button className="team-button primary" onClick={() => editProfile(selectedProfile)}>{t('edit')}</button></>}>
    {profileSummary(selectedProfile)}<p className="team-value">{selectedProfile.config.description}</p><h3>{t('prompt')}</h3><p className="team-value">{selectedProfile.config.systemPrompt}</p><h3>{t('tools')}</h3><p className="team-value">{selectedProfile.config.capabilities.tools.join(', ') || '—'}</p><h3>{t('skills')} / {t('mcp')}</h3><p className="team-value">{[...selectedProfile.config.capabilities.skills, ...selectedProfile.config.capabilities.mcpServers].join(', ') || '—'}</p><h3>{t('uses')}</h3><p className="team-value">{library.teams.filter(team => [team.config.leader, ...team.config.teammates].some(ref => ref.id === selectedProfile.id)).map(team => team.config.displayName).join(', ') || t('noUses')}</p><p className="team-id">{t('generatedId')}: {selectedProfile.id}</p>
  </Dialog>}
  {selectedTeam && <Dialog title={selectedTeam.config.displayName} onClose={() => setDetail(null)} footer={<><button className="team-button" onClick={() => requestAction('team', selectedTeam, 'delete')}>{t('delete')}</button><button className="team-button" onClick={() => requestAction('team', selectedTeam, 'fork')}>{t('fork')}</button><button className="team-button" onClick={() => editTeam(selectedTeam)}>{t('edit')}</button></>}>
    <p className="team-value">{selectedTeam.config.description}</p><p className="team-value">{selectedTeam.config.instructions}</p><p className="team-muted">{t('defaultWorkspace')}: {selectedTeam.config.defaultProjectKey ? projectLabel(projects, selectedTeam.config.defaultProjectKey) : t('noDefaultWorkspace')}</p>
    <section className="team-section"><h3>{t('allPeople')}</h3>{[selectedTeam.leader, ...selectedTeam.teammates].map(profile => <div key={profile.id} className="team-member-row">{profileSummary(profile)}</div>)}<p className="team-muted">{t('latest')}</p></section>
    <p className="team-id">{t('generatedId')}: {selectedTeam.id}</p>
  </Dialog>}
  {drafts.team && !drafts.profile && <TeamEditor draft={drafts.team} projects={projects} library={library} busy={busy} error={editorError} onChange={team => { if (!team.submitted) setEditorError(null); setDrafts(value => ({ ...value, team })); }} onSave={() => void saveTeam()} onClose={() => { setDrafts(value => ({ ...value, team: undefined })); setEditorError(null); }} onNewProfile={role => createProfile(role, true)} onForkProfile={profile => requestAction('profile', profile, 'fork')} onCreateProject={onCreateProject}/>}
  {drafts.profile && <ProfileEditor draft={drafts.profile} projects={projects} models={models} busy={busy} error={editorError} onChange={profile => { if (!profile.submitted) setEditorError(null); setDrafts(value => ({ ...value, profile })); }} onSave={() => void saveProfile()} onClose={() => { setDrafts(value => ({ ...value, profile: undefined })); setEditorError(null); }} onCreateProject={onCreateProject}/>}
    {pending && <Dialog title={t(pending.action === 'fork' ? 'fork' : 'delete')} onClose={() => setPending(null)} busy={busy} footer={<><button className="team-button" disabled={busy} onClick={() => setPending(null)}>{t('cancel')}</button><button className="team-button primary" disabled={busy || (pending.action === 'fork' && !pending.name.trim())} onClick={() => void applyAction()}>{busy ? t('saving') : t(pending.action === 'fork' ? 'fork' : 'delete')}</button></>}><ErrorBox error={pendingError}/><p className="team-muted">{pending.action === 'delete' ? t('deleteHelp') : t(pending.kind === 'team' ? 'teamForkHelp' : 'forkHelp')}</p>{pending.action === 'fork' && <Field label={t('name')}><input className="team-input" value={pending.name} disabled={busy} onChange={e => setPending({ ...pending, name: e.target.value, token: newRequestToken() })}/></Field>}</Dialog>}
  </div>;
}
