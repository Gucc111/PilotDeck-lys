import { useEffect, useState } from 'react';
import type { Project } from '../../types/app';
import type { ChatModelCatalogItem } from '../chat/hooks/useChatProviderState';
import { capabilityValues, modelSelectionId } from '../chat-v2/modelCapabilityOptions';
import { newRequestToken, teamCommand, type ProfileConfig, type TeamInventory } from './api';
import type { ProfileDraft } from './drafts';
import { Dialog, ErrorBox, Field, ProjectOptions } from './Shared';
import { useTeamText } from './text';

type Props = { draft: ProfileDraft; projects: Project[]; models: ChatModelCatalogItem[]; busy: boolean; error: string | null; onChange: (draft: ProfileDraft) => void; onSave: () => void; onClose: () => void; onCreateProject: () => void };
export function ProfileEditor({ draft, projects, models, busy, error, onChange, onSave, onClose, onCreateProject }: Props) {
  const t = useTeamText(); const config = draft.config;
  const [inventory, setInventory] = useState<TeamInventory>({ tools: [], skills: [], mcpServers: [] });
  const [inventoryError, setInventoryError] = useState<string | null>(null); const [generation, setGeneration] = useState(0); const [loading, setLoading] = useState(true);
  const [inventoryProject, setInventoryProject] = useState('');
  const projectKey = config.workspace.mode === 'fixed' ? config.workspace.projectKey : inventoryProject || undefined;
  useEffect(() => { let current = true; setLoading(true); setInventoryError(null); void teamCommand<TeamInventory>({ action: 'inventory', ...(projectKey ? { projectKey } : {}) }).then(value => { if (current) setInventory(value); }).catch(err => { if (current) setInventoryError(String(err.message)); }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [projectKey, generation]);
  const update = (patch: Partial<ProfileConfig>) => onChange({ ...draft, config: { ...config, ...patch } });
  const modelConfig = config.model;
  const selectedModel = modelConfig.mode === 'model' ? models.find(item => item.provider === modelConfig.provider && item.model === modelConfig.model) : undefined;
  const selectedModelId = config.model.mode === 'model' ? modelSelectionId(config.model) : 'default';
  const locked = busy || Boolean(draft.submitted);
  const capabilities = (key: keyof TeamInventory, kind: 'tool' | 'skill' | 'mcp', title: string) => {
    const available = inventory[key]; const selected = config.capabilities[key];
    const entries = [...available, ...selected.filter(name => !available.some(item => item.name === name)).map(name => ({ name, description: t('unavailable') }))];
    return <details className="team-section" open={key === 'tools'}><summary>{title} <span className="team-badge">{selected.length}</span></summary>
      {entries.length === 0 ? <p className="team-muted">{loading ? t('loading') : t('emptyCapabilities')}</p> : entries.map(item => {
        const checked = selected.includes(item.name); const optional = config.optionalCapabilities.some(cap => cap.kind === kind && cap.name === item.name);
        return <div key={item.name} className="team-capability"><div className="team-capability-label"><label className="team-check"><input type="checkbox" checked={checked} disabled={locked || loading || Boolean(inventoryError)} onChange={e => update({ capabilities: { ...config.capabilities, [key]: e.target.checked ? [...selected, item.name] : selected.filter(name => name !== item.name) }, optionalCapabilities: e.target.checked ? config.optionalCapabilities : config.optionalCapabilities.filter(cap => cap.kind !== kind || cap.name !== item.name) })}/><span>{item.name}</span></label><p className="team-muted">{item.description}</p></div>
          {checked && <label className="team-check"><input type="checkbox" aria-label={`${item.name} ${t('optional')}`} checked={optional} disabled={locked} onChange={e => update({ optionalCapabilities: e.target.checked ? [...config.optionalCapabilities, { kind, name: item.name }] : config.optionalCapabilities.filter(cap => cap.kind !== kind || cap.name !== item.name) })}/>{t('optional')}</label>}</div>;
      })}</details>;
  };
  return <Dialog title={`${draft.id ? t('edit') : t('createInline')} ${draft.role === 'leader' ? 'Leader' : 'Teammate'}`} busy={busy} onClose={onClose} footer={<>{draft.submitted && <button className="team-button" type="button" disabled={busy} onClick={() => onChange({ ...draft, submitted: false, requestToken: newRequestToken() })}>{t('newAttempt')}</button>}<button className="team-button" type="button" disabled={busy} onClick={onClose}>{t('discard')}</button><button className="team-button primary" type="submit" form="team-profile-form" disabled={busy}>{busy ? t('saving') : draft.submitted ? t('retry') : t('save')}</button></>}>
    <form id="team-profile-form" className="team-fields" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <ErrorBox error={error}/>
      <Field label={t('name')}><input className="team-input" required maxLength={200} value={config.displayName} disabled={locked} onChange={e => update({ displayName: e.target.value })}/></Field>
      <Field label={t('description')}><input className="team-input" value={config.description} disabled={locked} onChange={e => update({ description: e.target.value })}/></Field>
      <Field label={t('prompt')} hint={t('promptHelp')}><textarea className="team-input" rows={6} required value={config.systemPrompt} disabled={locked} onChange={e => update({ systemPrompt: e.target.value })}/></Field>
      <Field label={t('model')}><select className="team-input" value={selectedModelId} disabled={locked} onChange={e => { const chosen = models.find(item => item.id === e.target.value); update({ model: chosen ? { mode: 'model', provider: chosen.provider, model: chosen.model } : { mode: 'default' } }); }}><option value="default">{t('defaultModel')}</option>{config.model.mode === 'model' && !selectedModel && <option value={selectedModelId}>{selectedModelId} ({t('unavailable')})</option>}{models.filter(item => item.model && item.id !== 'auto').map(item => <option value={item.id} key={item.id}>{item.displayName || item.id}{item.available ? '' : ` (${t('unavailable')})`}</option>)}</select></Field>
      {selectedModel && config.model.mode === 'model' && <div className="team-columns">{(['reasoning', 'speed'] as const).map(key => {
        const options = capabilityValues(selectedModel.capabilities[key]); const current = config.model.mode === 'model' ? config.model[key] : undefined;
        if (!options.length) return null;
        return <Field key={key} label={t(key)}><select className="team-input" value={current ?? ''} disabled={locked} onChange={e => { if (config.model.mode !== 'model') return; const model = { ...config.model }; if (e.target.value === '') delete model[key]; else model[key] = Number(e.target.value); update({ model }); }}><option value="">{t('modelDefaultParameter')}</option>{options.map(value => <option value={value} key={value}>{value}</option>)}</select></Field>;
      })}</div>}
      <div className="team-columns"><Field label={t('workspace')}><select className="team-input" value={config.workspace.mode} disabled={locked} onChange={e => update({ workspace: e.target.value === 'team' ? { mode: 'team' } : { mode: 'fixed', projectKey: '' } })}><option value="team">{t('inheritedWorkspace')}</option><option value="fixed">{t('fixedWorkspace')}</option></select></Field>
        {config.workspace.mode === 'fixed' && <Field label={t('fixedWorkspace')}><select className="team-input" required value={config.workspace.projectKey} disabled={locked} onChange={e => update({ workspace: { mode: 'fixed', projectKey: e.target.value } })}><option value="">{t('selectProject')}</option><ProjectOptions projects={projects} selected={config.workspace.projectKey}/></select></Field>}</div>
      {projects.length === 0 && <div className="team-notice">{t('projectMissing')} <button type="button" className="team-button" onClick={onCreateProject}>{t('createProject')}</button></div>}
      <Field label={t('permission')}><select className="team-input" value={config.permissionMode} disabled={locked} onChange={e => update({ permissionMode: e.target.value as ProfileConfig['permissionMode'] })}><option value="default">{t('permissionDefault')}</option><option value="plan">{t('permissionPlan')}</option><option value="bypassPermissions">{t('permissionBypass')}</option></select></Field>
      {config.permissionMode === 'bypassPermissions' && <p className="team-notice team-warning">{t('bypassHelp')}</p>}
      <div>{config.workspace.mode === 'team' && projects.length > 0 && <Field label={t('inventoryProject')} hint={t('inventoryProjectHelp')}><select className="team-input" value={inventoryProject} disabled={locked} onChange={e => setInventoryProject(e.target.value)}><option value="">{t('globalCapabilities')}</option><ProjectOptions projects={projects}/></select></Field>}<p className="team-muted">{t('capabilityHelp')} {t('optionalHelp')}</p>{inventoryError && <div className="team-notice team-error">{t('capabilityLoadError')}<ErrorBox error={inventoryError}/><button type="button" className="team-button" onClick={() => setGeneration(n => n + 1)}>{t('retry')}</button></div>}{capabilities('tools', 'tool', t('tools'))}{capabilities('skills', 'skill', t('skills'))}{capabilities('mcpServers', 'mcp', t('mcp'))}</div>
      <p className="team-muted">{t('draftNotice')}</p><p className="team-id">{draft.id ? `${t('generatedId')}: ${draft.id}` : t('idHelp')}</p>
    </form>
  </Dialog>;
}
