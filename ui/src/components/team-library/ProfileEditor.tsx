import { useEffect, useState } from 'react';
import type { Project } from '../../types/app';
import type { ChatModelCatalogItem } from '../chat/hooks/useChatProviderState';
import { capabilityValues, modelSelectionId } from '../chat-v2/modelCapabilityOptions';
import { normalizeProfileTools, PLAN_TOOL_GROUP, WRITE_TOOL_GROUP } from '../../../../src/team/profileTools';
import { newRequestToken, teamCommand, type ProfileConfig, type TeamInventory } from './api';
import type { ProfileDraft } from './drafts';
import FolderBrowserModal from '../project-creation-wizard/components/FolderBrowserModal';
import { Dialog, ErrorBox, Field, ProjectOptions } from './Shared';
import { useTeamText } from './text';

type Props = { draft: ProfileDraft; projects: Project[]; models: ChatModelCatalogItem[]; busy: boolean; error: string | null; onChange: (draft: ProfileDraft) => void; onSave: () => void; onClose: () => void; onCreateProject: () => void };
export function ProfileEditor({ draft, projects, models, busy, error, onChange, onSave, onClose, onCreateProject }: Props) {
  const t = useTeamText(); const config = draft.config;
  const [inventory, setInventory] = useState<TeamInventory>({ tools: [], skills: [], mcpServers: [] });
  const [inventoryError, setInventoryError] = useState<string | null>(null); const [generation, setGeneration] = useState(0); const [loading, setLoading] = useState(true);
  const [inventoryProject, setInventoryProject] = useState(''); const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const projectKey = config.workspace.mode === 'fixed' ? config.workspace.projectKey : inventoryProject || undefined;
  useEffect(() => { let current = true; setLoading(true); setInventoryError(null); void teamCommand<TeamInventory>({ action: 'inventory', ...(projectKey ? { projectKey } : {}) }).then(value => { if (current) setInventory(value); }).catch(err => { if (current) setInventoryError(String(err.message)); }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [projectKey, generation]);
  const update = (patch: Partial<ProfileConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const modelConfig = config.model;
  const selectedModel = modelConfig.mode === 'model' ? models.find(item => item.provider === modelConfig.provider && item.model === modelConfig.model) : undefined;
  const selectedModelId = config.model.mode === 'model' ? modelSelectionId(config.model) : '';
  const locked = busy || Boolean(draft.submitted);
  const concreteModels = models.filter(item => item.model && item.id !== 'auto' && item.id !== 'router/auto');
  useEffect(() => {
    if (locked) return;
    const patch: Partial<ProfileConfig> = {};
    const firstModel = concreteModels.find(item => item.available);
    if (config.model.mode === 'default' && firstModel) patch.model = { mode: 'model', provider: firstModel.provider, model: firstModel.model };
    if (config.permissionMode === 'plan') patch.permissionMode = 'default';
    const normalized = normalizeProfileTools(config);
    if (JSON.stringify(normalized.capabilities) !== JSON.stringify(config.capabilities)) Object.assign(patch, normalized);
    if (Object.keys(patch).length) update(patch);
  });
  const capabilities = (key: keyof TeamInventory, kind: 'tool' | 'skill' | 'mcp', title: string) => {
    const available = inventory[key]; const selected = config.capabilities[key];
    const entries = [...available, ...selected.filter(name => !available.some(item => item.name === name)).map(name => ({ name, description: t('unavailable') }))];
    const writes = selected.includes('write_file');
    const plans = PLAN_TOOL_GROUP.some(name => selected.includes(name));
    const renderEntry = (item: typeof entries[number], names = [item.name], nested = false) => {
      const label = names.join(' / ');
      const checked = names.every(name => selected.includes(name));
      const dependency = kind === 'tool' && ((item.name === 'read_file' && writes) || (item.name === 'todo_write' && plans));
      return <div key={item.name} className={`team-capability${nested ? ' team-capability-child' : ''}`}><div className="team-capability-label"><label className="team-check"><input type="checkbox" checked={checked} disabled={locked || loading || Boolean(inventoryError) || dependency || (nested && !writes)} onChange={e => {
        const removed = !e.target.checked && names.includes('write_file') ? [...names, 'edit_notebook'] : names;
        const next = { ...config, capabilities: { ...config.capabilities, [key]: e.target.checked ? [...new Set([...selected, ...names])] : selected.filter(name => !removed.includes(name)) } };
        update(kind === 'tool' ? normalizeProfileTools(next) : next);
      }}/><span>{label}</span></label>{kind !== 'tool' && <p className="team-muted">{item.description}</p>}</div></div>;
    };
    const groupedNames = [...PLAN_TOOL_GROUP, ...WRITE_TOOL_GROUP, 'edit_notebook'];
    const toolEntries = entries.filter(item => !groupedNames.includes(item.name));
    for (const group of [PLAN_TOOL_GROUP, WRITE_TOOL_GROUP]) {
      if (entries.some(item => group.includes(item.name))) toolEntries.push({ name: group[0]!, description: '' });
    }
    return <details className="team-section" open={key === 'tools'}><summary>{title} <span className="team-badge">{selected.length}</span></summary>
      {entries.length === 0 ? <p className="team-muted">{loading ? t('loading') : t('emptyCapabilities')}</p> : kind !== 'tool' ? entries.map(item => renderEntry(item)) : toolEntries.map(item => {
        if (item.name === PLAN_TOOL_GROUP[0]) return renderEntry(item, PLAN_TOOL_GROUP);
        if (item.name === WRITE_TOOL_GROUP[0]) return <div key={item.name}>{renderEntry(item, WRITE_TOOL_GROUP)}{entries.some(entry => entry.name === 'edit_notebook') && renderEntry({ name: 'edit_notebook', description: '' }, ['edit_notebook'], true)}</div>;
        return renderEntry(item);
      })}</details>;
  };
  return <Dialog title={`${draft.id ? t('edit') : t('createInline')} ${draft.role === 'leader' ? 'Leader' : 'Teammate'}`} busy={busy} onClose={onClose} footer={<>{draft.submitted && <button className="team-button" type="button" disabled={busy} onClick={() => onChange({ ...draft, submitted: false, requestToken: newRequestToken() })}>{t('newAttempt')}</button>}<button className="team-button" type="button" disabled={busy} onClick={onClose}>{t('discard')}</button><button className="team-button primary" type="submit" form="team-profile-form" disabled={busy}>{busy ? t('saving') : draft.submitted ? t('retry') : t('save')}</button></>}>
    <form id="team-profile-form" className="team-fields" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <ErrorBox error={error}/>
      <Field label={t('name')}><input className="team-input" required maxLength={200} value={config.displayName} disabled={locked} onChange={e => update({ displayName: e.target.value })}/></Field>
      <Field label={t('description')}><input className="team-input" value={config.description} disabled={locked} onChange={e => update({ description: e.target.value })}/></Field>
      <Field label={t('prompt')} hint={t('promptHelp')}><textarea className="team-input" rows={6} required value={config.systemPrompt} disabled={locked} onChange={e => update({ systemPrompt: e.target.value })}/></Field>
      <Field label={t('model')}><select className="team-input" required value={selectedModelId} disabled={locked} onChange={e => { const chosen = concreteModels.find(item => `${item.provider}/${item.model}` === e.target.value); if (chosen) update({ model: { mode: 'model', provider: chosen.provider, model: chosen.model } }); }}>{!selectedModelId && <option value="" disabled>{t('selectModel')}</option>}{config.model.mode === 'model' && !selectedModel && <option value={selectedModelId}>{selectedModelId} ({t('unavailable')})</option>}{concreteModels.map(item => <option value={`${item.provider}/${item.model}`} key={item.id} disabled={!item.available}>{item.displayName || item.id}{item.available ? '' : ` (${t('unavailable')})`}</option>)}</select></Field>
      {concreteModels.length === 0 && <p className="team-notice">{t('noModel')}</p>}
      {selectedModel && config.model.mode === 'model' && <div className="team-columns">{(['reasoning', 'speed'] as const).map(key => {
        const options = capabilityValues(selectedModel.capabilities[key]); const current = config.model.mode === 'model' ? config.model[key] : undefined;
        if (!options.length) return null;
        return <Field key={key} label={t(key)}><select className="team-input" value={current ?? ''} disabled={locked} onChange={e => { if (config.model.mode !== 'model') return; const model = { ...config.model }; if (e.target.value === '') delete model[key]; else model[key] = Number(e.target.value); update({ model }); }}><option value="">{t('modelDefaultParameter')}</option>{options.map(value => <option value={value} key={value}>{value}</option>)}</select></Field>;
      })}</div>}
      <div className="team-columns"><Field label={t('workspace')}><select className="team-input" value={config.workspace.mode} disabled={locked} onChange={e => update({ workspace: e.target.value === 'team' ? { mode: 'team' } : { mode: 'fixed', projectKey: '' } })}><option value="team">{t('inheritedWorkspace')}</option><option value="fixed">{t('fixedWorkspace')}</option></select></Field>
        {config.workspace.mode === 'fixed' && (draft.role === 'teammate'
          ? <Field label={t('fixedWorkspace')} hint={t('teammateWorkspaceHelp')}><div className="team-workspace-input"><input className="team-input" required value={config.workspace.projectKey} disabled={locked} placeholder="/absolute/path/to/directory" onChange={e => update({ workspace: { mode: 'fixed', projectKey: e.target.value } })}/><button type="button" className="team-button" disabled={locked} onClick={() => setShowFolderBrowser(true)}>{t('chooseDirectory')}</button></div></Field>
          : <Field label={t('fixedWorkspace')} hint={t('leaderWorkspaceHelp')}><select className="team-input" required value={config.workspace.projectKey} disabled={locked} onChange={e => update({ workspace: { mode: 'fixed', projectKey: e.target.value } })}><option value="">{t('selectProject')}</option><ProjectOptions projects={projects} selected={config.workspace.projectKey}/></select></Field>)}</div>
      {projects.length === 0 && <div className="team-notice">{t('projectMissing')} <button type="button" className="team-button" onClick={onCreateProject}>{t('createProject')}</button></div>}
      <Field label={t('permission')}><select className="team-input" value={config.permissionMode} disabled={locked} onChange={e => update({ permissionMode: e.target.value as ProfileConfig['permissionMode'] })}><option value="default">{t('permissionDefault')}</option><option value="bypassPermissions">{t('permissionBypass')}</option></select></Field>
      {config.permissionMode === 'bypassPermissions' && <p className="team-notice team-warning">{t('bypassHelp')}</p>}
      <div>{config.workspace.mode === 'team' && projects.length > 0 && <Field label={t('inventoryProject')} hint={t('inventoryProjectHelp')}><select className="team-input" value={inventoryProject} disabled={locked} onChange={e => setInventoryProject(e.target.value)}><option value="">{t('globalCapabilities')}</option><ProjectOptions projects={projects}/></select></Field>}<p className="team-muted">{t('capabilityHelp')}</p>{inventoryError && <div className="team-notice team-error">{t('capabilityLoadError')}<ErrorBox error={inventoryError}/><button type="button" className="team-button" onClick={() => setGeneration(n => n + 1)}>{t('retry')}</button></div>}{capabilities('tools', 'tool', t('tools'))}{capabilities('skills', 'skill', t('skills'))}{capabilities('mcpServers', 'mcp', t('mcp'))}</div>
      {draft.role === 'teammate' && config.workspace.mode === 'fixed' && <FolderBrowserModal isOpen={showFolderBrowser} initialPath={config.workspace.projectKey} autoAdvanceOnSelect={false} onClose={() => setShowFolderBrowser(false)} onFolderSelected={path => { update({ workspace: { mode: 'fixed', projectKey: path } }); setShowFolderBrowser(false); }}/>}
      <p className="team-muted">{t('draftNotice')}</p><p className="team-id">{draft.id ? `${t('generatedId')}: ${draft.id}` : t('idHelp')}</p>
    </form>
  </Dialog>;
}
