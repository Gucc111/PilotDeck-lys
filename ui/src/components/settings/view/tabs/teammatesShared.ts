import type { ReactNode } from 'react';
import type { ToolCallSelector } from '../../../../../../src/permission/protocol/types';
import { cn } from '../../../../lib/utils';
import type {
  SettingsProject,
  TeammateCatalog,
  TeammateDefinition,
  TeammateDiagnostic,
  TeammateRecord,
  TeammateWorkspaceBinding,
  TeammateWorkspaceBindings,
} from '../../types/types';

export type EditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; originalId: string };

export type TeammateDraft = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string;
  tools: string;
  plugins: string;
  skills: string;
  mcpServers: string;
};

export type DraftField = keyof TeammateDraft;
export type ArrayDraftField = 'tools' | 'plugins' | 'skills' | 'mcpServers';
export type ValidationErrors = Partial<Record<DraftField, string>>;

export type TeammatesView =
  | { kind: 'list' }
  | { kind: 'detail'; teammateId: string }
  | { kind: 'new' };

export type ProjectOption = {
  label: string;
  value: string;
};

export const INPUT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring';
export const TEXTAREA_CLASS =
  'w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring';
export const TEAMMATE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
export const ARRAY_FIELDS: ArrayDraftField[] = ['tools', 'plugins', 'skills', 'mcpServers'];

export const EMPTY_DRAFT: TeammateDraft = {
  id: '',
  name: '',
  description: '',
  prompt: '',
  model: '',
  tools: '',
  plugins: '',
  skills: '',
  mcpServers: '',
};

export function validateDraft(
  draft: TeammateDraft,
  t: (key: string) => string,
): ValidationErrors {
  const errors: ValidationErrors = {};
  const id = draft.id.trim();
  if (!id) {
    errors.id = t('teammates.validation.idRequired');
  } else if (!TEAMMATE_ID_RE.test(id) || id.includes('..')) {
    errors.id = t('teammates.validation.idInvalid');
  }
  if (!draft.name.trim()) errors.name = t('teammates.validation.nameRequired');
  if (!draft.prompt.trim()) errors.prompt = t('teammates.validation.promptRequired');
  return errors;
}

export function definitionFromDraft(draft: TeammateDraft): TeammateDefinition {
  const model = draft.model.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    ...(model ? { model } : {}),
    tools: parseArrayField(draft.tools),
    plugins: parseArrayField(draft.plugins),
    skills: parseArrayField(draft.skills),
    mcpServers: parseArrayField(draft.mcpServers),
  };
}

export function draftFromTeammate(teammate: TeammateRecord): TeammateDraft {
  return {
    id: teammate.id,
    name: teammate.name,
    description: teammate.description || '',
    prompt: teammate.prompt,
    model: teammate.model || '',
    tools: teammate.tools.join('\n'),
    plugins: teammate.plugins.join('\n'),
    skills: teammate.skills.join('\n'),
    mcpServers: teammate.mcpServers.join('\n'),
  };
}

export function parseArrayField(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

export function normalizeTeammates(value: unknown): TeammateRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return [];
    const id = entry.id.trim();
    if (!id) return [];
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      ...(typeof entry.model === 'string' && entry.model ? { model: entry.model } : {}),
      tools: normalizeStringArray(entry.tools),
      plugins: normalizeStringArray(entry.plugins),
      skills: normalizeStringArray(entry.skills),
      mcpServers: normalizeStringArray(entry.mcpServers),
      relativePath: typeof entry.relativePath === 'string' ? entry.relativePath : '',
      filePath: typeof entry.filePath === 'string' ? entry.filePath : '',
    }];
  });
}

export function normalizeDiagnostics(value: unknown): TeammateDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.message !== 'string') return [];
    return [{
      code: typeof entry.code === 'string' ? entry.code : 'UNKNOWN',
      severity: entry.severity === 'warning' ? 'warning' : 'error',
      message: entry.message,
      ...(typeof entry.relativePath === 'string' ? { relativePath: entry.relativePath } : {}),
      ...(typeof entry.field === 'string' ? { field: entry.field } : {}),
      ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
      ...(Array.isArray(entry.relatedPaths)
        ? { relatedPaths: normalizeStringArray(entry.relatedPaths) }
        : {}),
    }];
  });
}

export function normalizeCatalog(value: Record<string, unknown>): TeammateCatalog {
  return {
    tools: normalizeStringArray(value.tools),
    plugins: normalizeStringArray(value.plugins),
    skills: normalizeStringArray(value.skills),
    mcpServers: normalizeStringArray(value.mcpServers),
    diagnostics: normalizeDiagnostics(value.diagnostics),
  };
}

export function normalizeWorkspaceBindings(
  value: Record<string, unknown>,
): TeammateWorkspaceBindings {
  const bindings: Record<string, TeammateWorkspaceBinding> = {};
  if (isRecord(value.bindings)) {
    for (const [id, candidate] of Object.entries(value.bindings)) {
      if (!isRecord(candidate) || typeof candidate.enabled !== 'boolean') continue;
      const profile = candidate.toolProfile;
      if (!isRecord(profile)) continue;
      if (profile.mode === 'inherit') {
        bindings[id] = {
          enabled: candidate.enabled,
          toolProfile: { mode: 'inherit' },
          contextPolicy: normalizeContextPolicy(candidate.contextPolicy),
        };
        continue;
      }
      if (profile.mode !== 'custom' || !isRecord(profile.constraints)) continue;
      bindings[id] = {
        enabled: candidate.enabled,
        contextPolicy: normalizeContextPolicy(candidate.contextPolicy),
        toolProfile: {
          mode: 'custom',
          tools: normalizeStringArray(profile.tools),
          constraints: {
            allow: normalizeSelectors(profile.constraints.allow),
            deny: normalizeSelectors(profile.constraints.deny),
          },
        },
      };
    }
  }
  return {
    canonicalProjectKey:
      typeof value.canonicalProjectKey === 'string' ? value.canonicalProjectKey : '',
    bindings,
    revision: typeof value.revision === 'string' ? value.revision : '',
    filePath: typeof value.filePath === 'string' ? value.filePath : '',
  };
}

function normalizeContextPolicy(value: unknown): TeammateWorkspaceBinding['contextPolicy'] {
  return value === 'fresh_per_delegation' ? 'fresh_per_delegation' : 'persistent';
}

function normalizeSelectors(value: unknown): ToolCallSelector[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate)
      || candidate.version !== 2
      || typeof candidate.toolName !== 'string'
    ) {
      return [];
    }
    return [candidate as ToolCallSelector];
  });
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())),
  );
}

export function extractResponseDiagnostics(data: Record<string, unknown>): TeammateDiagnostic[] {
  const direct = normalizeDiagnostics(data.diagnostics);
  if (direct.length > 0) return direct;
  if (isRecord(data.validation)) return normalizeDiagnostics(data.validation.diagnostics);
  return [];
}

export function apiError(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.details === 'string' && data.details.trim()) return data.details;
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  return fallback;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function fieldClass(base: string, error?: string): string {
  return cn(base, error && 'border-destructive focus:border-destructive focus:ring-destructive');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildProjectOptions(projects: SettingsProject[]): ProjectOption[] {
  return projects
    .map((project) => ({
      label: project.displayName || project.name || project.fullPath || project.path || '',
      value: (project.fullPath || project.path || '').trim(),
    }))
    .filter((project) => project.value);
}
