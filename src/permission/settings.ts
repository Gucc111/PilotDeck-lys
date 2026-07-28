import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePilotHome } from "../pilot/paths.js";
import type { PermissionRule } from "./protocol/types.js";
import {
  DEFAULT_PERMISSION_SETTINGS,
  migrateLegacyPermissionEntry,
  normalizePermissionEntry,
  normalizePermissionRules,
  normalizePermissionSettings,
  permissionEntryToRule,
  permissionSettingsToRuleSet,
  type PermissionSettings,
} from "./settingsSchema.js";

export {
  DEFAULT_PERMISSION_SETTINGS,
  migrateLegacyPermissionEntry,
  normalizePermissionEntry,
  normalizePermissionRules,
  normalizePermissionSettings,
  permissionEntryToRule,
  permissionSettingsToRuleSet,
  type PermissionSettings,
} from "./settingsSchema.js";

export function getPermissionSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePilotHome(env), "permissions.json");
}

export function readPermissionSettings(env: NodeJS.ProcessEnv = process.env): PermissionSettings {
  try {
    const raw = readFileSync(getPermissionSettingsPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizePermissionSettings(parsed);
  } catch {
    return { ...DEFAULT_PERMISSION_SETTINGS };
  }
}

export function writePermissionSettings(
  updates: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PermissionSettings {
  const current = readPermissionSettings(env);
  const record = isRecord(updates) ? updates : {};
  const rules = mergeRuleUpdates(current.rules, record);
  const next = normalizePermissionSettings({
    ...current,
    ...record,
    rules,
    lastUpdated: new Date().toISOString(),
  });
  const filePath = getPermissionSettingsPath(env);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function mergeRuleUpdates(
  currentRules: PermissionRule[],
  updates: Record<string, unknown>,
): PermissionRule[] {
  if (Array.isArray(updates.rules)) {
    return normalizePermissionRules(updates.rules);
  }
  let next = [...currentRules];
  if (Array.isArray(updates.allowedTools)) {
    next = next.filter((rule) => rule.behavior !== "allow");
    next.push(...updates.allowedTools
      .map((entry) => migrateLegacyPermissionEntry(entry, "allow"))
      .filter((rule): rule is PermissionRule => Boolean(rule)));
  }
  if (Array.isArray(updates.disallowedTools)) {
    next = next.filter((rule) => rule.behavior !== "deny");
    next.push(...updates.disallowedTools
      .map((entry) => migrateLegacyPermissionEntry(entry, "deny"))
      .filter((rule): rule is PermissionRule => Boolean(rule)));
  }
  return normalizePermissionRules(next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
