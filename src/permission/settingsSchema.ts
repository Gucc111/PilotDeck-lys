import type {
  PermissionRule,
  PermissionRuleBehavior,
  PermissionRuleSet,
  PermissionRuleSource,
  ToolCallCondition,
  ToolCallSelector,
} from "./protocol/types.js";

export type PermissionSettings = {
  version: 2;
  rules: PermissionRule[];
  skipPermissions: boolean;
  lastUpdated?: string;
};

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  version: 2,
  rules: [],
  skipPermissions: true,
};

const RULE_BEHAVIORS = new Set<PermissionRuleBehavior>(["allow", "deny", "ask"]);
const RULE_SOURCES = new Set<PermissionRuleSource>(["user", "project", "session", "policy", "cli"]);
const KNOWN_TOOL_NAMES = new Set([
  "read_file",
  "send_attachment",
  "write_file",
  "edit_file",
  "edit_notebook",
  "glob",
  "grep",
  "bash",
  "agent",
  "todo_write",
  "web_fetch",
  "web_search",
]);

const TOOL_NAME_ALIASES = new Map<string, string>([
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["NotebookEdit", "edit_notebook"],
  ["MultiEdit", "edit_file"],
  ["Glob", "glob"],
  ["Grep", "grep"],
  ["Bash", "bash"],
  ["Task", "agent"],
  ["TodoWrite", "todo_write"],
  ["WebFetch", "web_fetch"],
  ["WebSearch", "web_search"],
]);

const PATH_SUBJECT_BY_TOOL = new Map<string, ToolCallCondition["subject"]>([
  ["read_file", "read_file.file_path"],
  ["send_attachment", "send_attachment.file_path"],
  ["write_file", "write_file.file_path"],
  ["edit_file", "edit_file.file_path"],
  ["edit_notebook", "edit_notebook.notebook_path"],
]);

export function normalizePermissionSettings(value: unknown): PermissionSettings {
  const record = isRecord(value) ? value : {};
  const explicitRules = Array.isArray(record.rules)
    ? normalizePermissionRules(record.rules)
    : undefined;
  const rules = explicitRules ?? [
    ...normalizeLegacyEntries(record.allowedTools, "allow"),
    ...normalizeLegacyEntries(record.disallowedTools, "deny"),
  ];

  return {
    version: 2,
    rules,
    skipPermissions: typeof record.skipPermissions === "boolean"
      ? record.skipPermissions
      : DEFAULT_PERMISSION_SETTINGS.skipPermissions,
    lastUpdated: typeof record.lastUpdated === "string" ? record.lastUpdated : undefined,
  };
}

export function normalizePermissionRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionRule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const rule = normalizePermissionRule(item);
    if (!rule) continue;
    const key = permissionRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

export function normalizePermissionRule(
  value: unknown,
  defaults: {
    behavior?: PermissionRuleBehavior;
    source?: PermissionRuleSource;
  } = {},
): PermissionRule | null {
  if (!isRecord(value)) return null;
  const behavior = RULE_BEHAVIORS.has(value.behavior as PermissionRuleBehavior)
    ? value.behavior as PermissionRuleBehavior
    : defaults.behavior;
  const source = RULE_SOURCES.has(value.source as PermissionRuleSource)
    ? value.source as PermissionRuleSource
    : defaults.source ?? "user";
  const rawToolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
  const toolName = normalizeToolName(rawToolName);
  if (!behavior || !toolName) return null;

  const selector = normalizeToolCallSelector(value.selector);
  const pattern = typeof value.pattern === "string" && value.pattern.trim()
    ? value.pattern.trim()
    : undefined;
  if (value.selector !== undefined && !selector && !pattern) {
    return null;
  }
  if (selector && selector.toolName !== toolName) {
    return null;
  }

  return {
    source,
    behavior,
    toolName,
    ...(pattern ? { pattern } : {}),
    ...(selector ? { selector } : {}),
    ...(value.legacyInert === true ? { legacyInert: true } : {}),
  };
}

export function permissionSettingsToRuleSet(settings: PermissionSettings): PermissionRuleSet {
  const result: PermissionRuleSet = { allow: [], deny: [], ask: [] };
  for (const rule of settings.rules) {
    if (rule.behavior === "deny") {
      result.deny.push(rule);
    } else {
      result[rule.behavior].push(rule);
    }
  }
  return result;
}

export function permissionEntryToRule(
  entry: string,
  behavior: "allow" | "deny",
  source: PermissionRuleSource = "user",
): PermissionRule {
  const structured = parseSerializedPermissionRule(entry, behavior, source);
  if (structured) return structured;
  return migrateLegacyPermissionEntry(entry, behavior, source) ?? {
    source,
    behavior,
    toolName: "",
  };
}

export function migrateLegacyPermissionEntry(
  entry: unknown,
  behavior: "allow" | "deny",
  source: PermissionRuleSource = "user",
): PermissionRule | null {
  if (typeof entry !== "string") return null;
  const trimmedEntry = entry.trim();
  const rawSeparator = trimmedEntry.indexOf(":");
  const hasLegacyAliasPrefix = rawSeparator > 0
    && TOOL_NAME_ALIASES.has(trimmedEntry.slice(0, rawSeparator).trim());
  const normalized = normalizePermissionEntry(entry);
  if (!normalized) return null;
  const separator = normalized.indexOf(":");
  const toolName = separator < 0 ? normalized : normalized.slice(0, separator);
  const pattern = separator < 0 ? "" : normalized.slice(separator + 1).trim();
  if (!toolName) return null;

  const legacyRule: PermissionRule = {
    source,
    behavior,
    toolName,
    ...(pattern ? { pattern } : {}),
    ...(hasLegacyAliasPrefix ? { legacyInert: true } : {}),
  };
  if (hasLegacyAliasPrefix) return legacyRule;
  const selector = legacyEntryToSelector(toolName, pattern, behavior);
  return selector ? { ...legacyRule, pattern: undefined, selector } : legacyRule;
}

export function normalizePermissionEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  const bashMatch = /^Bash\((.*)\)$/.exec(trimmed);
  if (bashMatch) {
    const pattern = bashMatch[1]?.trim();
    return pattern ? `bash:${pattern}` : "bash";
  }
  // Preserve V1 behavior: aliases were recognized only when the complete
  // entry was an alias. Converting an alias before `:` would activate legacy
  // entries that were previously inert and could silently expand allow rules.
  return normalizeToolName(trimmed);
}

export function normalizeToolName(value: string): string {
  return TOOL_NAME_ALIASES.get(value.trim()) ?? value.trim();
}

export function permissionRuleKey(rule: PermissionRule): string {
  return JSON.stringify({
    behavior: rule.behavior,
    toolName: rule.toolName,
    pattern: rule.pattern,
    legacyInert: rule.legacyInert,
    selector: rule.selector
      ? {
          version: rule.selector.version,
          toolName: rule.selector.toolName,
          conditions: rule.selector.conditions ?? [],
        }
      : undefined,
  });
}

export function serializePermissionRule(rule: PermissionRule): string {
  return JSON.stringify(normalizePermissionRule(rule) ?? rule);
}

function normalizeLegacyEntries(value: unknown, behavior: "allow" | "deny"): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules = value
    .map((entry) => migrateLegacyPermissionEntry(entry, behavior))
    .filter((rule): rule is PermissionRule => Boolean(rule));
  return normalizePermissionRules(rules);
}

function legacyEntryToSelector(
  toolName: string,
  pattern: string,
  behavior: PermissionRuleBehavior,
): ToolCallSelector | null {
  if (!pattern) {
    // A legacy bare allow for write/edit was workspace-scoped by the matcher.
    // A condition-less selector would allow paths outside the workspace.
    if (behavior === "allow" && (toolName === "write_file" || toolName === "edit_file")) {
      return null;
    }
    return KNOWN_TOOL_NAMES.has(toolName) ? { version: 2, toolName } : null;
  }
  if (toolName === "bash") return legacyBashPatternToSelector(pattern, behavior);
  const subject = PATH_SUBJECT_BY_TOOL.get(toolName);
  return subject ? legacyPathPatternToSelector(toolName, subject, pattern) : null;
}

function legacyBashPatternToSelector(
  pattern: string,
  behavior: PermissionRuleBehavior,
): ToolCallSelector | null {
  if (!/(:\*|\*)$/.test(pattern)) return null;
  const prefix = pattern.replace(/(:\*|\*)$/, "").trim();
  if (!prefix || /[;&|`$(){}[\]<>\\'"]/.test(prefix)) return null;
  const tokens = prefix.split(/\s+/);
  if (!tokens.every((token) => /^[A-Za-z0-9_./@+=,%~-]+$/.test(token))) return null;
  // For deny rules, a mid-token wildcard (e.g. `rm -r*`) would match more
  // broadly than an exact argvPrefix. Only migrate if the `*` was at a clean
  // token boundary. Trailing `:*` is always a clean separator; a bare `*`
  // must be preceded by whitespace to indicate a full-token wildcard.
  if (behavior === "deny" && !pattern.endsWith(":*")) {
    const charBeforeStar = pattern[pattern.length - 2];
    if (charBeforeStar && !/\s/.test(charBeforeStar)) return null;
  }
  const conditions: ToolCallCondition[] = [{
    subject: "bash.command",
    operator: "executableEquals",
    value: tokens[0]!,
  }];
  if (tokens.length > 1) {
    conditions.push({
      subject: "bash.command",
      operator: "argvPrefix",
      value: tokens,
    });
  }
  return { version: 2, toolName: "bash", conditions };
}

function legacyPathPatternToSelector(
  toolName: string,
  subject: ToolCallCondition["subject"],
  pattern: string,
): ToolCallSelector | null {
  // Relative paths and $WORKSPACE were not expanded by the V1 matcher.
  // Upgrading either would silently grant access that V1 did not grant.
  const absolute = pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern);
  if (!absolute) return null;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return {
      version: 2,
      toolName,
      conditions: [{ subject, operator: "pathEquals", value: pattern } as ToolCallCondition],
    };
  }
  if (/[/\\]\*$/.test(pattern) && !/[*?]/.test(pattern.slice(0, -1))) {
    return {
      version: 2,
      toolName,
      conditions: [{
        subject,
        operator: "pathWithin",
        value: pattern.slice(0, -2) || "/",
      } as ToolCallCondition],
    };
  }
  return null;
}

function normalizeToolCallSelector(value: unknown): ToolCallSelector | null {
  if (!isRecord(value) || value.version !== 2 || typeof value.toolName !== "string") {
    return null;
  }
  const toolName = normalizeToolName(value.toolName);
  if (!toolName) return null;
  if (value.conditions === undefined) return { version: 2, toolName };
  if (!Array.isArray(value.conditions)) return null;
  const conditions: ToolCallCondition[] = [];
  for (const condition of value.conditions) {
    if (
      !isRecord(condition)
      || typeof condition.subject !== "string"
      || typeof condition.operator !== "string"
    ) {
      return null;
    }
    const rawValue = condition.value;
    if (condition.operator === "argvPrefix") {
      if (
        !Array.isArray(rawValue)
        || rawValue.length === 0
        || !rawValue.every((item) => typeof item === "string" && item.length > 0)
      ) {
        return null;
      }
    } else if (typeof rawValue !== "string" || !rawValue.trim()) {
      return null;
    }
    conditions.push({
      subject: condition.subject,
      operator: condition.operator,
      value: rawValue,
    } as ToolCallCondition);
  }
  return { version: 2, toolName, ...(conditions.length ? { conditions } : {}) };
}

function parseSerializedPermissionRule(
  entry: string,
  behavior: PermissionRuleBehavior,
  source: PermissionRuleSource,
): PermissionRule | null {
  if (!entry.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(entry) as unknown;
    return normalizePermissionRule(
      isRecord(parsed) ? { ...parsed, behavior, source } : parsed,
      { behavior, source },
    );
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
