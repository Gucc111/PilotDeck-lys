import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Loader2,
  Save,
  Trash2,
} from 'lucide-react';
import { parse as parseYaml } from 'yaml';
import { Button, Select } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { usePilotDeckConfig } from '../../../../hooks/usePilotDeckConfig';
import { buildModelRefOptions, type ModelRefOption } from '../../../../shared/buildModelRefOptions';
import type {
  SettingsProject,
  TeamSetDefinition,
  TeamSetLeaderConfig,
  TeamSetTeammateConfig,
  TeammateRecord,
  TeammateToolProfile,
} from '../../types/types';
import {
  INPUT_CLASS,
  TEXTAREA_CLASS,
  readJson,
  apiError,
  isRecord,
  normalizeTeammates,
} from './teammatesShared';

type Props = {
  id: string | null;
  projects: SettingsProject[];
  onBack: () => void;
};

const LEADER_MODES = ['inherit', 'override', 'standalone'] as const;

const INHERIT_TOOL_PROFILE: TeammateToolProfile = { mode: 'inherit' };

export default function TeamSetEditor({ id, projects, onBack }: Props) {
  const { t } = useTranslation('settings');
  const isNew = id === null;

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState('');

  const [tsId, setTsId] = useState('');
  const [tsName, setTsName] = useState('');
  const [tsDescription, setTsDescription] = useState('');
  const [leaderMode, setLeaderMode] = useState<typeof LEADER_MODES[number]>('inherit');
  const [leaderPrompt, setLeaderPrompt] = useState('');
  const [leaderModel, setLeaderModel] = useState('');

  const [allTeammates, setAllTeammates] = useState<TeammateRecord[]>([]);
  const [teammateConfigs, setTeammateConfigs] = useState<Record<string, TeamSetTeammateConfig>>({});

  const requestSeq = useRef(0);

  const { raw: configRaw } = usePilotDeckConfig();
  const modelOptions: ModelRefOption[] = useMemo(() => {
    if (!configRaw) return [];
    try {
      const parsed = parseYaml(configRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return buildModelRefOptions(parsed.model?.providers);
      }
    } catch { /* ignore */ }
    return [];
  }, [configRaw]);

  const modelSelectOptions = useMemo(() => [
    { value: '', label: t('teamSet.fields.modelDefault') },
    ...modelOptions,
  ], [modelOptions, t]);

  const loadTeammates = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/teammates');
      const data = await readJson(response);
      if (response.ok) {
        setAllTeammates(normalizeTeammates(data.teammates));
      }
    } catch { /* ignore */ }
  }, []);

  const loadTeamSet = useCallback(async (teamSetId: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/team-sets/${encodeURIComponent(teamSetId)}`);
      const data = await readJson(response);
      if (seq !== requestSeq.current) return;
      if (!response.ok) {
        setError(apiError(data, t('teamSet.errors.loadFailed')));
        return;
      }
      const ts = data.teamSet;
      if (!isRecord(ts)) return;
      setTsId(typeof ts.id === 'string' ? ts.id : '');
      setTsName(typeof ts.name === 'string' ? ts.name : '');
      setTsDescription(typeof ts.description === 'string' ? ts.description : '');
      setRevision(typeof data.revision === 'string' ? data.revision : '');

      if (isRecord(ts.leader)) {
        const mode = ts.leader.mode;
        if (mode === 'override' || mode === 'standalone') {
          setLeaderMode(mode);
          setLeaderPrompt(typeof ts.leader.prompt === 'string' ? ts.leader.prompt : '');
          setLeaderModel(typeof ts.leader.model === 'string' ? ts.leader.model : '');
        } else {
          setLeaderMode('inherit');
        }
      }

      if (isRecord(ts.teammates)) {
        const configs: Record<string, TeamSetTeammateConfig> = {};
        for (const [tmId, cfg] of Object.entries(ts.teammates)) {
          if (!isRecord(cfg)) continue;
          configs[tmId] = {
            toolProfile: isRecord(cfg.toolProfile) ? cfg.toolProfile as TeammateToolProfile : INHERIT_TOOL_PROFILE,
            ...(cfg.contextPolicy === 'fresh_per_delegation' ? { contextPolicy: 'fresh_per_delegation' as const } : {}),
            ...(typeof cfg.modelOverride === 'string' ? { modelOverride: cfg.modelOverride } : {}),
            ...(typeof cfg.promptOverride === 'string' ? { promptOverride: cfg.promptOverride } : {}),
          };
        }
        setTeammateConfigs(configs);
      }
    } catch {
      if (seq === requestSeq.current) setError(t('teamSet.errors.loadFailed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadTeammates(); }, [loadTeammates]);
  useEffect(() => {
    if (id) void loadTeamSet(id);
  }, [id, loadTeamSet]);

  const buildTeamSetPayload = (): Omit<TeamSetDefinition, 'id'> & { id?: string } => {
    const leader: TeamSetLeaderConfig = leaderMode === 'inherit'
      ? { mode: 'inherit' }
      : {
          mode: leaderMode,
          ...(leaderPrompt.trim() ? { prompt: leaderPrompt.trim() } : {}),
          ...(leaderModel.trim() ? { model: leaderModel.trim() } : {}),
        };

    return {
      ...(isNew ? { id: tsId.trim() } : {}),
      name: tsName.trim() || tsId.trim(),
      ...(tsDescription.trim() ? { description: tsDescription.trim() } : {}),
      leader,
      teammates: teammateConfigs,
    };
  };

  const save = async () => {
    setError(null);
    setMessage(null);
    if (!tsId.trim()) {
      setError(t('teamSet.errors.idRequired'));
      return;
    }

    setSaving(true);
    try {
      const payload = buildTeamSetPayload();
      const response = isNew
        ? await authenticatedFetch('/api/team-sets', {
            method: 'POST',
            body: JSON.stringify({ teamSet: payload }),
          })
        : await authenticatedFetch(`/api/team-sets/${encodeURIComponent(id!)}`, {
            method: 'PUT',
            body: JSON.stringify({ teamSet: payload, expectedRevision: revision }),
          });

      const data = await readJson(response);
      if (!response.ok) {
        if (response.status === 409) {
          if (id) await loadTeamSet(id);
          setError(t('teamSet.errors.revisionConflict'));
        } else {
          setError(apiError(data, t('teamSet.errors.saveFailed')));
        }
        return;
      }
      setRevision(typeof data.revision === 'string' ? data.revision : revision);
      if (isNew && typeof data.id === 'string') {
        setTsId(data.id);
      }
      setMessage(t('teamSet.messages.saved'));
    } catch {
      setError(t('teamSet.errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !window.confirm(t('teamSet.confirmDelete'))) return;
    setDeleting(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/team-sets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const data = await readJson(response);
        setError(apiError(data, t('teamSet.errors.deleteFailed')));
        return;
      }
      onBack();
    } catch {
      setError(t('teamSet.errors.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const toggleTeammate = (teammateId: string, enabled: boolean) => {
    setTeammateConfigs((prev) => {
      if (enabled) {
        return { ...prev, [teammateId]: { toolProfile: INHERIT_TOOL_PROFILE } };
      }
      const next = { ...prev };
      delete next[teammateId];
      return next;
    });
  };

  const updateTeammateConfig = (teammateId: string, updates: Partial<TeamSetTeammateConfig>) => {
    setTeammateConfigs((prev) => ({
      ...prev,
      [teammateId]: { ...prev[teammateId]!, ...updates },
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4 rotate-180" />
        {t('teamSet.backToTeam')}
      </button>

      <h3 className="text-lg font-semibold text-foreground">
        {isNew ? t('teamSet.titleNew') : (tsName || tsId)}
      </h3>

      {(error || message) && (
        <div
          role={error ? 'alert' : undefined}
          className={`rounded-lg border px-4 py-3 text-sm ${
            error
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border bg-card/60 text-muted-foreground'
          }`}
        >
          {error || message}
        </div>
      )}

      {/* Metadata */}
      <Section title={t('teamSet.sections.metadata')}>
        <Field label={t('teamSet.fields.id')}>
          <input
            value={tsId}
            onChange={(e) => setTsId(e.target.value)}
            disabled={!isNew}
            placeholder="my-team-set"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label={t('teamSet.fields.name')}>
          <input
            value={tsName}
            onChange={(e) => setTsName(e.target.value)}
            placeholder={t('teamSet.fields.namePlaceholder')}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label={t('teamSet.fields.description')}>
          <input
            value={tsDescription}
            onChange={(e) => setTsDescription(e.target.value)}
            placeholder={t('teamSet.fields.descriptionPlaceholder')}
            className={INPUT_CLASS}
          />
        </Field>
      </Section>

      {/* Leader config */}
      <Section title={t('teamSet.sections.leader')}>
        <Field label={t('teamSet.fields.leaderMode')}>
          <Select
            value={leaderMode}
            onChange={(v) => setLeaderMode(v as typeof leaderMode)}
            options={LEADER_MODES.map((m) => ({
              value: m,
              label: t(`teamSet.leaderModes.${m}`),
            }))}
          />
        </Field>
        {leaderMode !== 'inherit' && (
          <>
            <Field label={t('teamSet.fields.leaderPrompt')}>
              <textarea
                value={leaderPrompt}
                onChange={(e) => setLeaderPrompt(e.target.value)}
                rows={4}
                className={TEXTAREA_CLASS}
              />
            </Field>
            <Field label={t('teamSet.fields.leaderModel')}>
              <Select
                value={leaderModel}
                onChange={setLeaderModel}
                options={modelSelectOptions}
              />
            </Field>
          </>
        )}
      </Section>

      {/* Teammates */}
      <Section title={t('teamSet.sections.teammates')}>
        {allTeammates.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('teamSet.noTeammates')}</p>
        ) : (
          <div className="space-y-3">
            {allTeammates.map((tm) => {
              const enabled = tm.id in teammateConfigs;
              const config = teammateConfigs[tm.id];
              return (
                <div key={tm.id} className="rounded-lg border border-border bg-background/70 p-3 space-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleTeammate(tm.id, e.target.checked)}
                      className="h-4 w-4 rounded border-border accent-primary"
                    />
                    <span className="font-medium text-foreground">{tm.name}</span>
                    <span className="text-xs text-muted-foreground">({tm.id})</span>
                  </label>

                  {enabled && config && (
                    <div className="ml-6 space-y-3">
                      <Field label={t('teamSet.fields.modelOverride')}>
                        <Select
                          value={config.modelOverride ?? ''}
                          onChange={(v) => updateTeammateConfig(tm.id, {
                            modelOverride: v || undefined,
                          })}
                          options={modelSelectOptions}
                        />
                      </Field>
                      <Field label={t('teamSet.fields.promptOverride')}>
                        <textarea
                          value={config.promptOverride ?? ''}
                          onChange={(e) => updateTeammateConfig(tm.id, {
                            promptOverride: e.target.value || undefined,
                          })}
                          rows={3}
                          placeholder={t('teamSet.fields.promptOverridePlaceholder')}
                          className={TEXTAREA_CLASS}
                        />
                      </Field>
                      <Field label={t('teamSet.fields.contextPolicy')}>
                        <Select
                          value={config.contextPolicy ?? 'persistent'}
                          onChange={(v) => updateTeammateConfig(tm.id, {
                            contextPolicy: v as 'persistent' | 'fresh_per_delegation',
                          })}
                          options={[
                            { value: 'persistent', label: t('teamSet.contextPolicies.persistent') },
                            { value: 'fresh_per_delegation', label: t('teamSet.contextPolicies.fresh') },
                          ]}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <div>
          {!isNew && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void remove()}
              disabled={saving || deleting}
              className="text-destructive hover:text-destructive"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('teamSet.actions.delete')}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack} disabled={saving}>
            {t('teamSet.actions.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || deleting}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('teamSet.actions.saving') : t('teamSet.actions.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
