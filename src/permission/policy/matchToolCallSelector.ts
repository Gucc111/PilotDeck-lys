import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseShellCommandSegments } from "../../tool/builtin/bash/permissions.js";
import type {
  PathSubject,
  ToolCallCondition,
  ToolCallConditionMatchResult,
  ToolCallSelector,
  ToolCallSelectorMatchResult,
  ToolParameterDescriptor,
} from "../protocol/types.js";
import type { PermissionContext } from "../protocol/types.js";

export type ToolCallSelectorMatchOptions = {
  commandAggregation?: "all" | "any";
  commandExecutableMatch?: "exact" | "basename";
  commandParseFailureMatch?: boolean;
  /** When true, unresolvable paths (dangling symlinks, null bytes) match the selector. */
  pathResolveFailureMatch?: boolean;
};

const COMMAND_OPERATORS = ["executableEquals", "argvPrefix"] as const;
const PATH_OPERATORS = ["pathEquals", "pathWithin"] as const;

export const BUILTIN_TOOL_PARAMETER_DESCRIPTORS: readonly ToolParameterDescriptor[] = [
  { toolName: "bash", subject: "bash.command", kind: "command", operators: COMMAND_OPERATORS },
  ...pathDescriptors("read_file", ["read_file.file_path", "read_file.target_path"]),
  ...pathDescriptors("send_attachment", ["send_attachment.file_path", "send_attachment.target_path"]),
  ...pathDescriptors("write_file", ["write_file.file_path", "write_file.target_path"]),
  ...pathDescriptors("edit_file", ["edit_file.file_path", "edit_file.target_path"]),
  ...pathDescriptors("edit_notebook", ["edit_notebook.notebook_path", "edit_notebook.target_path"]),
  ...pathDescriptors("glob", ["glob.search_root"]),
  ...pathDescriptors("grep", ["grep.path", "grep.search_root"]),
];

export function matchToolCallSelector(
  selector: ToolCallSelector,
  toolName: string,
  input: unknown,
  context?: PermissionContext,
  options: ToolCallSelectorMatchOptions = {},
): ToolCallSelectorMatchResult {
  if (!isV2Selector(selector) || !matchesToolName(selector.toolName, toolName)) {
    return result(selector, false, "tool_mismatch");
  }

  const conditions = selector.conditions ?? [];
  if (conditions.length === 0) {
    return result(selector, true, "matched");
  }

  if (!BUILTIN_TOOL_PARAMETER_DESCRIPTORS.some((descriptor) => descriptor.toolName === toolName)) {
    return result(selector, false, "unsupported_tool", conditions.map(unsupportedConditionResult));
  }
  if (conditions.some((condition) => !isConditionRecord(condition))) {
    return result(selector, false, "unsupported_condition");
  }
  const descriptors = conditions.map((condition) => findDescriptor(toolName, condition));
  if (descriptors.some((descriptor) => !descriptor)) {
    return result(selector, false, "unsupported_condition", conditions.map(unsupportedConditionResult));
  }

  if (toolName === "bash") {
    return matchCommandConditions(
      selector,
      conditions,
      input,
      options.commandAggregation ?? "all",
      options.commandExecutableMatch ?? "exact",
      options.commandParseFailureMatch ?? false,
    );
  }

  return matchPathConditions(
    selector,
    toolName,
    conditions,
    input,
    context,
    options.pathResolveFailureMatch ?? false,
  );
}

function matchCommandConditions(
  selector: ToolCallSelector,
  conditions: readonly ToolCallCondition[],
  input: unknown,
  aggregation: "all" | "any",
  executableMatch: "exact" | "basename",
  parseFailureMatch: boolean,
): ToolCallSelectorMatchResult {
  const command = readString(input, "command");
  const segments = command ? parseShellCommandSegments(command) : undefined;
  if (!segments) {
    return result(selector, parseFailureMatch, "invalid_input", conditions.map((condition) => ({
      condition,
      matched: parseFailureMatch,
      reason: parseFailureMatch
        ? "The shell command could not be parsed reliably and restrictive matching is fail-closed."
        : "The shell command could not be parsed reliably.",
    })));
  }

  const segmentMatches = segments.map((segment) =>
    conditions.every((condition) =>
      matchCommandCondition(condition, segment, executableMatch))
  );
  const matched = aggregation === "all"
    ? segmentMatches.every(Boolean)
    : segmentMatches.some(Boolean);
  const conditionResults = conditions.map((condition): ToolCallConditionMatchResult => {
    const matches = segments.map((segment) =>
      matchCommandCondition(condition, segment, executableMatch));
    const conditionMatched = aggregation === "all" ? matches.every(Boolean) : matches.some(Boolean);
    return {
      condition,
      matched: conditionMatched,
      reason: conditionMatched
        ? `Command condition matched with ${aggregation}-segment semantics.`
        : `Command condition did not match with ${aggregation}-segment semantics.`,
    };
  });
  return result(selector, matched, matched ? "matched" : "condition_mismatch", conditionResults);
}

function matchCommandCondition(
  condition: ToolCallCondition,
  segment: {
    rawExecutable: string;
    executable: string;
    argv: string[];
    environmentWrapped: boolean;
  },
  executableMatch: "exact" | "basename",
): boolean {
  if (condition.subject !== "bash.command") {
    return false;
  }
  if (segment.environmentWrapped && executableMatch === "exact") {
    return false;
  }
  if (condition.operator === "executableEquals") {
    return normalizeCommandExecutable(segment.rawExecutable, condition.value, executableMatch)
      === normalizeExecutableReference(condition.value);
  }
  if (condition.operator === "argvPrefix" && Array.isArray(condition.value)) {
    if (condition.value.length === 0) return false;
    const fullArgv = [
      normalizeCommandExecutable(
        segment.rawExecutable,
        condition.value[0] ?? "",
        executableMatch,
      ),
      ...segment.argv,
    ];
    const normalizedPrefix = condition.value.map((value, index) =>
      index === 0 ? normalizeExecutableReference(value) : value
    );
    return startsWith(fullArgv, normalizedPrefix);
  }
  return false;
}

function matchPathConditions(
  selector: ToolCallSelector,
  toolName: string,
  conditions: readonly ToolCallCondition[],
  input: unknown,
  context: PermissionContext | undefined,
  resolveFailureMatch: boolean,
): ToolCallSelectorMatchResult {
  if (!context) {
    return result(selector, resolveFailureMatch, "invalid_input", conditions.map((condition) => ({
      condition,
      matched: resolveFailureMatch,
      reason: resolveFailureMatch
        ? "Path matching requires a permission context; restrictive matching is fail-closed."
        : "Path matching requires a permission context.",
    })));
  }

  const inputPath = extractPathParameter(toolName, input);
  const candidate = inputPath ? canonicalizePath(inputPath, context.cwd) : undefined;
  if (!candidate) {
    return result(selector, resolveFailureMatch, "invalid_input", conditions.map((condition) => ({
      condition,
      matched: resolveFailureMatch,
      reason: resolveFailureMatch
        ? "The path could not be resolved (dangling symlink or invalid input); restrictive matching is fail-closed."
        : "The tool input did not contain a valid path parameter.",
    })));
  }

  const conditionResults = conditions.map((condition): ToolCallConditionMatchResult => {
    if (condition.subject === "bash.command" || typeof condition.value !== "string") {
      return unsupportedConditionResult(condition);
    }
    const expected = canonicalizePath(expandWorkspacePath(condition.value, context.cwd), context.cwd);
    const matched = expected
      ? condition.operator === "pathEquals"
        ? candidate === expected
        : condition.operator === "pathWithin" && isPathWithin(candidate, expected)
      : false;
    return {
      condition,
      matched,
      reason: matched
        ? `${condition.operator} matched the canonical path.`
        : `${condition.operator} did not match the canonical path.`,
    };
  });
  const matched = conditionResults.every((condition) => condition.matched);
  return result(selector, matched, matched ? "matched" : "condition_mismatch", conditionResults);
}

function extractPathParameter(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (toolName === "edit_notebook") {
    return readString(input, "notebook_path");
  }
  if (toolName === "glob") {
    const pattern = readString(input, "pattern");
    if (pattern && path.isAbsolute(pattern)) {
      return extractAbsoluteGlobBaseDirectory(pattern);
    }
    return readString(input, "path") ?? ".";
  }
  if (toolName === "grep") {
    return readString(input, "path") ?? ".";
  }
  return readString(input, "file_path") ?? readString(input, "filePath");
}

function extractAbsoluteGlobBaseDirectory(pattern: string): string | undefined {
  if (!path.isAbsolute(pattern) || pattern.includes("\0")) return undefined;
  const wildcardIndex = pattern.search(/[*?[{]/);
  if (wildcardIndex < 0) {
    return path.dirname(pattern);
  }
  const staticPrefix = pattern.slice(0, wildcardIndex);
  const separatorIndex = Math.max(staticPrefix.lastIndexOf("/"), staticPrefix.lastIndexOf(path.sep));
  if (separatorIndex < 0) return undefined;
  return separatorIndex === 0 ? path.parse(pattern).root : staticPrefix.slice(0, separatorIndex);
}

function canonicalizePath(value: string, cwd: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const absolute = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed));
  let existing = absolute;
  const suffix: string[] = [];
  while (!pathExistsPhysically(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    const real = realpathSync(existing);
    return path.resolve(real, ...suffix);
  } catch {
    // realpathSync fails for dangling symlinks (lstat succeeds but target
    // is missing). Return undefined so the caller treats it as unresolvable:
    // allow selectors won't match (fail-closed) and deny selectors can use
    // conservative matching via parseFailureMatch-style handling.
    return undefined;
  }
}

function pathExistsPhysically(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function expandWorkspacePath(value: string, cwd: string): string {
  if (value === "$WORKSPACE") return cwd;
  if (value.startsWith("$WORKSPACE/") || value.startsWith("$WORKSPACE\\")) {
    return path.join(cwd, value.slice("$WORKSPACE".length + 1));
  }
  return value;
}

function findDescriptor(toolName: string, condition: ToolCallCondition): ToolParameterDescriptor | undefined {
  return BUILTIN_TOOL_PARAMETER_DESCRIPTORS.find((descriptor) =>
    descriptor.toolName === toolName
    && descriptor.subject === condition.subject
    && descriptor.operators.includes(condition.operator)
  );
}

function pathDescriptors(toolName: string, subjects: PathSubject[]): ToolParameterDescriptor[] {
  return subjects.map((subject) => ({
    toolName,
    subject,
    kind: "path",
    operators: PATH_OPERATORS,
  }));
}

function unsupportedConditionResult(condition: ToolCallCondition): ToolCallConditionMatchResult {
  return {
    condition,
    matched: false,
    reason: "The tool does not support this subject/operator combination.",
  };
}

function result(
  selector: ToolCallSelector,
  matched: boolean,
  reason: ToolCallSelectorMatchResult["reason"],
  conditionResults: ToolCallConditionMatchResult[] = [],
): ToolCallSelectorMatchResult {
  return { matched, selector, conditionResults, reason };
}

function isV2Selector(selector: ToolCallSelector): boolean {
  return isRecord(selector)
    && selector.version === 2
    && typeof selector.toolName === "string"
    && (selector.conditions === undefined || Array.isArray(selector.conditions));
}

function isConditionRecord(condition: ToolCallCondition): boolean {
  if (
    !isRecord(condition)
    || typeof condition.subject !== "string"
    || typeof condition.operator !== "string"
    || !("value" in condition)
  ) {
    return false;
  }
  if (condition.operator === "argvPrefix") {
    return Array.isArray(condition.value)
      && condition.value.length > 0
      && condition.value.every((value) => typeof value === "string");
  }
  return typeof condition.value === "string" && condition.value.trim().length > 0;
}

function matchesToolName(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true;
  return ruleToolName.includes("*") && wildcardToRegExp(ruleToolName).test(toolName);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function startsWith(values: string[], prefix: string[]): boolean {
  return prefix.length <= values.length && prefix.every((value, index) => values[index] === value);
}

function normalizeExecutable(value: string): string {
  const parts = value.trim().replace(/\\/g, "/").split("/");
  return (parts.at(-1) ?? value).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

function normalizeExecutableReference(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized.includes("/")) return normalizeExecutable(normalized);
  const parts = normalized.split("/");
  const executable = parts.pop() ?? "";
  return [...parts, normalizeExecutable(executable)].join("/");
}

function normalizeCommandExecutable(
  actual: string,
  expected: string,
  mode: "exact" | "basename",
): string {
  const expectedReference = normalizeExecutableReference(expected);
  if (mode === "basename" && !expectedReference.includes("/")) {
    return normalizeExecutable(actual);
  }
  return normalizeExecutableReference(actual);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readString(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
