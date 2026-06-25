import { resolve } from "node:path";
import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic } from "../../pilot/config/types.js";
import type {
  AlwaysOnConfig,
  AlwaysOnDormancyConfig,
  AlwaysOnMemoryConfig,
  AlwaysOnProjectConfig,
  AlwaysOnPromptLanguage,
  AlwaysOnTriggerConfig,
  AlwaysOnWorkspaceConfig,
} from "./types.js";
import { defaultAlwaysOnConfig } from "./defaults.js";
import {
  REMOVED_DORMANCY_KEYS,
  REMOVED_MEMORY_KEYS,
  REMOVED_PROJECT_KEYS,
  REMOVED_TOP_LEVEL_KEYS,
  REMOVED_WORKSPACE_KEYS,
} from "./removed.js";
import {
  booleanField,
  nonNegativeInteger,
  nonNegativeNumber,
  positiveInteger,
  positiveNumber,
} from "./validators.js";

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "enabled",
  "language",
  "trigger",
  "dormancy",
  "workspace",
  "memory",
  "projects",
]);

const VALID_LANGUAGES = new Set<string>(["en", "zh-CN"]);

export function parseAlwaysOnConfig(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): AlwaysOnConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_CONFIG_INVALID",
      severity: "fatal",
      message: "alwaysOn config must be an object.",
      path: "alwaysOn",
      recoverable: false,
    });
    return undefined;
  }

  const result = defaultAlwaysOnConfig();
  result.enabled = booleanField(raw, "enabled", result.enabled);

  if (typeof raw.language === "string" && VALID_LANGUAGES.has(raw.language)) {
    result.language = raw.language as AlwaysOnPromptLanguage;
  } else if (raw.language !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_LANGUAGE_INVALID",
      severity: "warning",
      message: `alwaysOn.language must be "en" or "zh-CN"; ignoring "${String(raw.language)}".`,
      path: "alwaysOn.language",
      recoverable: true,
    });
  }

  for (const key of Object.keys(raw)) {
    const removalReason = REMOVED_TOP_LEVEL_KEYS[key];
    if (removalReason) {
      diagnostics.push({
        code: "ALWAYS_ON_FIELD_REMOVED",
        severity: "warning",
        message: removalReason,
        path: `alwaysOn.${key}`,
        recoverable: true,
      });
      continue;
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push({
        code: "ALWAYS_ON_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown alwaysOn field ${key}.`,
        path: `alwaysOn.${key}`,
        recoverable: true,
      });
    }
  }

  if (raw.trigger !== undefined) {
    parseTrigger(raw.trigger, result.trigger, diagnostics);
  }
  if (raw.dormancy !== undefined) {
    parseDormancy(raw.dormancy, result.dormancy, diagnostics);
  }
  if (raw.workspace !== undefined) {
    parseWorkspace(raw.workspace, result.workspace, diagnostics);
  }
  if (raw.memory !== undefined) {
    parseMemory(raw.memory, result.memory, diagnostics);
  }
  if (raw.projects !== undefined) {
    result.projects = parseProjects(raw.projects, diagnostics);
  }

  return result;
}

function parseTrigger(
  raw: unknown,
  target: AlwaysOnTriggerConfig,
  diagnostics: PilotConfigDiagnostic[],
): void {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_TRIGGER_INVALID",
      severity: "fatal",
      message: "alwaysOn.trigger must be an object.",
      path: "alwaysOn.trigger",
      recoverable: false,
    });
    return;
  }
  target.enabled = booleanField(raw, "enabled", target.enabled);
  target.tickIntervalMinutes = positiveNumber(
    raw.tickIntervalMinutes,
    target.tickIntervalMinutes,
    "alwaysOn.trigger.tickIntervalMinutes",
    diagnostics,
  );
  target.cooldownMinutes = nonNegativeNumber(
    raw.cooldownMinutes,
    target.cooldownMinutes,
    "alwaysOn.trigger.cooldownMinutes",
    diagnostics,
  );
  target.dailyBudget = nonNegativeInteger(
    raw.dailyBudget,
    target.dailyBudget,
    "alwaysOn.trigger.dailyBudget",
    diagnostics,
  );
  target.heartbeatStaleSeconds = positiveNumber(
    raw.heartbeatStaleSeconds,
    target.heartbeatStaleSeconds,
    "alwaysOn.trigger.heartbeatStaleSeconds",
    diagnostics,
  );
  target.recentUserMsgMinutes = nonNegativeNumber(
    raw.recentUserMsgMinutes,
    target.recentUserMsgMinutes,
    "alwaysOn.trigger.recentUserMsgMinutes",
    diagnostics,
  );
  if (typeof raw.preferChannel === "string" && raw.preferChannel.length > 0) {
    target.preferChannel = raw.preferChannel;
  } else if (raw.preferChannel !== undefined) {
    diagnostics.push({
      code: "ALWAYS_ON_TRIGGER_PREFER_CHANNEL_INVALID",
      severity: "warning",
      message: "alwaysOn.trigger.preferChannel must be a non-empty string; falling back to default.",
      path: "alwaysOn.trigger.preferChannel",
      recoverable: true,
    });
  }
}

function parseDormancy(
  raw: unknown,
  target: AlwaysOnDormancyConfig,
  diagnostics: PilotConfigDiagnostic[],
): void {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_DORMANCY_INVALID",
      severity: "fatal",
      message: "alwaysOn.dormancy must be an object.",
      path: "alwaysOn.dormancy",
      recoverable: false,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    const removed = REMOVED_DORMANCY_KEYS[key];
    if (removed) {
      diagnostics.push({
        code: "ALWAYS_ON_FIELD_REMOVED",
        severity: "warning",
        message: removed,
        path: `alwaysOn.dormancy.${key}`,
        recoverable: true,
      });
    }
  }
  target.debounceMs = nonNegativeInteger(
    raw.debounceMs,
    target.debounceMs,
    "alwaysOn.dormancy.debounceMs",
    diagnostics,
  );
  if (raw.ignoreGlobs !== undefined) {
    if (Array.isArray(raw.ignoreGlobs)) {
      const filtered = raw.ignoreGlobs.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      );
      target.ignoreGlobs = filtered;
    } else {
      diagnostics.push({
        code: "ALWAYS_ON_DORMANCY_IGNORE_GLOBS_INVALID",
        severity: "warning",
        message: "alwaysOn.dormancy.ignoreGlobs must be an array of strings; falling back to default.",
        path: "alwaysOn.dormancy.ignoreGlobs",
        recoverable: true,
      });
    }
  }
}

function parseWorkspace(
  raw: unknown,
  target: AlwaysOnWorkspaceConfig,
  diagnostics: PilotConfigDiagnostic[],
): void {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_WORKSPACE_INVALID",
      severity: "fatal",
      message: "alwaysOn.workspace must be an object.",
      path: "alwaysOn.workspace",
      recoverable: false,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    const removed = REMOVED_WORKSPACE_KEYS[key];
    if (removed) {
      diagnostics.push({
        code: "ALWAYS_ON_FIELD_REMOVED",
        severity: "warning",
        message: removed,
        path: `alwaysOn.workspace.${key}`,
        recoverable: true,
      });
    }
  }
  target.snapshotMaxBytes = positiveInteger(
    raw.snapshotMaxBytes,
    target.snapshotMaxBytes,
    "alwaysOn.workspace.snapshotMaxBytes",
    diagnostics,
  );
  target.maxPlansPerCycle = positiveInteger(
    raw.maxPlansPerCycle,
    target.maxPlansPerCycle,
    "alwaysOn.workspace.maxPlansPerCycle",
    diagnostics,
  );
}

function parseMemory(
  raw: unknown,
  target: AlwaysOnMemoryConfig,
  diagnostics: PilotConfigDiagnostic[],
): void {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_MEMORY_INVALID",
      severity: "fatal",
      message: "alwaysOn.memory must be an object.",
      path: "alwaysOn.memory",
      recoverable: false,
    });
    return;
  }
  for (const key of Object.keys(raw)) {
    const removed = REMOVED_MEMORY_KEYS[key];
    if (removed) {
      diagnostics.push({
        code: "ALWAYS_ON_FIELD_REMOVED",
        severity: "warning",
        message: removed,
        path: `alwaysOn.memory.${key}`,
        recoverable: true,
      });
    }
  }
  target.extractionThreshold = positiveInteger(
    raw.extractionThreshold,
    target.extractionThreshold,
    "alwaysOn.memory.extractionThreshold",
    diagnostics,
  );
  target.consolidationThreshold = positiveInteger(
    raw.consolidationThreshold,
    target.consolidationThreshold,
    "alwaysOn.memory.consolidationThreshold",
    diagnostics,
  );
}

function parseProjects(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): Record<string, AlwaysOnProjectConfig> {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "ALWAYS_ON_PROJECTS_INVALID",
      severity: "fatal",
      message: "alwaysOn.projects must be an object keyed by absolute project root.",
      path: "alwaysOn.projects",
      recoverable: false,
    });
    return {};
  }

  const projects: Record<string, AlwaysOnProjectConfig> = {};
  for (const [rootKey, value] of Object.entries(raw)) {
    if (typeof rootKey !== "string" || rootKey.trim().length === 0) {
      continue;
    }
    if (!isRecord(value)) {
      diagnostics.push({
        code: "ALWAYS_ON_PROJECT_INVALID",
        severity: "fatal",
        message: `alwaysOn.projects.${rootKey} must be an object.`,
        path: `alwaysOn.projects.${rootKey}`,
        recoverable: false,
      });
      continue;
    }
    for (const innerKey of Object.keys(value)) {
      const removed = REMOVED_PROJECT_KEYS[innerKey];
      if (removed) {
        diagnostics.push({
          code: "ALWAYS_ON_FIELD_REMOVED",
          severity: "warning",
          message: removed,
          path: `alwaysOn.projects.${rootKey}.${innerKey}`,
          recoverable: true,
        });
      } else if (innerKey !== "enabled") {
        diagnostics.push({
          code: "ALWAYS_ON_PROJECT_UNKNOWN_FIELD",
          severity: "warning",
          message: `Unknown alwaysOn.projects.${rootKey}.${innerKey}; only 'enabled' is accepted.`,
          path: `alwaysOn.projects.${rootKey}.${innerKey}`,
          recoverable: true,
        });
      }
    }
    const enabled = typeof value.enabled === "boolean" ? value.enabled : false;
    const normalizedKey = resolve(rootKey);
    projects[normalizedKey] = { enabled };
  }
  return projects;
}
