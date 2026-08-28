import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Crown, Layers, Loader2, Plus, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { SettingsProject, TeamSetSummary } from '../../types/types';
import { readJson, isRecord, buildProjectOptions } from './teammatesShared';
import TeammatesTab from './TeammatesTab';
import LeaderDetail from './LeaderTab';
import TeamSetEditor from './TeamSetEditor';

type TeamView =
  | { kind: 'home' }
  | { kind: 'leader' }
  | { kind: 'teammates' }
  | { kind: 'teamSet'; id: string }
  | { kind: 'newTeamSet' };

export default function TeamTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const projectOptions = useMemo(() => buildProjectOptions(projects), [projects]);

  const [view, setView] = useState<TeamView>({ kind: 'home' });
  const [teammatesInList, setTeammatesInList] = useState(true);

  const [leaderConfigured, setLeaderConfigured] = useState(false);
  const [leaderChecking, setLeaderChecking] = useState(true);

  const [teamSets, setTeamSets] = useState<TeamSetSummary[]>([]);
  const [teamSetsLoading, setTeamSetsLoading] = useState(true);

  const [selectedProject, setSelectedProject] = useState(projectOptions[0]?.value ?? '');
  const [assignedTeamSetId, setAssignedTeamSetId] = useState<string | null>(null);
  const [assignmentRevision, setAssignmentRevision] = useState('');
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);

  const checkLeaderStatus = useCallback(async () => {
    setLeaderChecking(true);
    try {
      const response = await authenticatedFetch('/api/leader');
      const data = await readJson(response);
      if (response.ok && isRecord(data.leader)) {
        const leader = data.leader;
        setLeaderConfigured(Boolean(
          (typeof leader.prompt === 'string' && leader.prompt) ||
          (typeof leader.model === 'string' && leader.model) ||
          (Array.isArray(leader.tools) && leader.tools.length > 0),
        ));
      } else {
        setLeaderConfigured(false);
      }
    } catch {
      setLeaderConfigured(false);
    } finally {
      setLeaderChecking(false);
    }
  }, []);

  const loadTeamSets = useCallback(async () => {
    setTeamSetsLoading(true);
    try {
      const response = await authenticatedFetch('/api/team-sets');
      const data = await readJson(response);
      if (response.ok && Array.isArray(data.teamSets)) {
        setTeamSets(data.teamSets.filter(
          (ts: unknown) => isRecord(ts) && typeof ts.id === 'string',
        ) as TeamSetSummary[]);
      }
    } catch { /* ignore */ }
    finally { setTeamSetsLoading(false); }
  }, []);

  const loadAssignment = useCallback(async (projectPath: string) => {
    if (!projectPath) return;
    setAssignmentLoading(true);
    setAssignmentError(null);
    try {
      const response = await authenticatedFetch(
        `/api/team-sets/assignment?projectPath=${encodeURIComponent(projectPath)}`,
      );
      const data = await readJson(response);
      if (response.ok) {
        setAssignedTeamSetId(typeof data.teamSetId === 'string' ? data.teamSetId : null);
        setAssignmentRevision(typeof data.revision === 'string' ? data.revision : '');
      }
    } catch {
      setAssignmentError(t('team.assignment.loadError'));
    } finally {
      setAssignmentLoading(false);
    }
  }, [t]);

  const saveAssignment = useCallback(async (teamSetId: string | null) => {
    if (!selectedProject || assignmentSaving) return;
    setAssignmentSaving(true);
    setAssignmentError(null);
    try {
      const response = await authenticatedFetch('/api/team-sets/assignment', {
        method: 'PUT',
        body: JSON.stringify({
          projectKey: selectedProject,
          teamSetId,
          expectedRevision: assignmentRevision,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        if (response.status === 409) {
          await loadAssignment(selectedProject);
          setAssignmentError(t('team.assignment.conflictError'));
        } else {
          setAssignmentError(typeof data.error === 'string' ? data.error : t('team.assignment.saveError'));
        }
        return;
      }
      setAssignedTeamSetId(typeof data.teamSetId === 'string' ? data.teamSetId : null);
      setAssignmentRevision(typeof data.revision === 'string' ? data.revision : '');
    } catch {
      setAssignmentError(t('team.assignment.saveError'));
    } finally {
      setAssignmentSaving(false);
    }
  }, [selectedProject, assignmentRevision, assignmentSaving, t, loadAssignment]);

  useEffect(() => { void checkLeaderStatus(); }, [checkLeaderStatus]);
  useEffect(() => { void loadTeamSets(); }, [loadTeamSets]);
  useEffect(() => {
    if (selectedProject) void loadAssignment(selectedProject);
  }, [selectedProject, loadAssignment]);

  if (view.kind === 'leader') {
    return (
      <LeaderDetail
        projects={projects}
        onBack={() => {
          setView({ kind: 'home' });
          void checkLeaderStatus();
        }}
      />
    );
  }

  if (view.kind === 'teammates') {
    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => setView({ kind: 'home' })}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4 rotate-180" />
          {t('team.backToTeam')}
        </button>
        <TeammatesTab projects={projects} onViewChange={setTeammatesInList} />
      </div>
    );
  }

  if (view.kind === 'teamSet' || view.kind === 'newTeamSet') {
    return (
      <TeamSetEditor
        id={view.kind === 'teamSet' ? view.id : null}
        projects={projects}
        onBack={() => {
          setView({ kind: 'home' });
          void loadTeamSets();
          if (selectedProject) void loadAssignment(selectedProject);
        }}
      />
    );
  }

  const assignmentOptions = [
    { value: '', label: t('team.assignment.none') },
    ...teamSets.map((ts) => ({ value: ts.id, label: ts.name || ts.id })),
  ];

  return (
    <div className="space-y-6">
      {/* Workspace selector + Team Set assignment */}
      {projectOptions.length > 0 && (
        <div className="rounded-lg border border-border bg-card/60 p-4 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-foreground">{t('team.assignment.title')}</h4>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('team.assignment.description')}</p>
          </div>

          {projectOptions.length > 1 && (
            <Select
              value={selectedProject}
              onChange={(v) => setSelectedProject(v)}
              options={projectOptions}
            />
          )}

          {assignmentLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Select
                value={assignedTeamSetId ?? ''}
                onChange={(v) => void saveAssignment(v || null)}
                options={assignmentOptions}
              />
              {assignmentSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          )}

          {assignmentError && (
            <p className="text-xs text-destructive">{assignmentError}</p>
          )}

          {assignedTeamSetId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView({ kind: 'teamSet', id: assignedTeamSetId })}
            >
              {t('team.assignment.editTeamSet')}
            </Button>
          )}
        </div>
      )}

      {/* Team Sets list */}
      <div className="rounded-lg border border-border bg-card/60 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-muted-foreground" />
            <div>
              <h4 className="text-sm font-semibold text-foreground">{t('team.teamSets.title')}</h4>
              <p className="text-xs leading-5 text-muted-foreground">{t('team.teamSets.description')}</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setView({ kind: 'newTeamSet' })}>
            <Plus className="h-4 w-4" />
            {t('team.teamSets.new')}
          </Button>
        </div>

        {teamSetsLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : teamSets.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">{t('team.teamSets.empty')}</p>
        ) : (
          <div className="space-y-2">
            {teamSets.map((ts) => (
              <button
                key={ts.id}
                type="button"
                onClick={() => setView({ kind: 'teamSet', id: ts.id })}
                className="group flex w-full items-center gap-4 rounded-lg border border-border bg-background/70 p-3 text-left transition-colors hover:bg-accent/30"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{ts.name || ts.id}</span>
                  {ts.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{ts.description}</p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Global definitions */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">{t('team.globalDefs.title')}</h4>

        <button
          type="button"
          onClick={() => setView({ kind: 'leader' })}
          className="group flex w-full items-center gap-4 rounded-lg border border-border bg-card/60 p-4 text-left transition-colors hover:bg-accent/30"
        >
          <Crown className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {t('team.leaderCard.title')}
              </span>
              {leaderChecking ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  leaderConfigured
                    ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {leaderConfigured
                    ? t('team.leaderCard.configured')
                    : t('team.leaderCard.notConfigured')}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t('team.leaderCard.description')}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>

        <button
          type="button"
          onClick={() => setView({ kind: 'teammates' })}
          className="group flex w-full items-center gap-4 rounded-lg border border-border bg-card/60 p-4 text-left transition-colors hover:bg-accent/30"
        >
          <Users className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-foreground">
              {t('team.teammatesCard.title')}
            </span>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t('team.teammatesCard.description')}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}
