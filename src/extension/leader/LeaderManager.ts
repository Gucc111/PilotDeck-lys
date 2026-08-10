import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { getPilotLeaderDefinitionFilePath } from "../../pilot/paths.js";
import {
  LEADER_SCHEMA_VERSION,
  type LeaderDefinition,
  type LeaderDiagnostic,
  type LeaderDiagnosticCode,
  type LeaderDocumentInput,
  type LeaderManagerOptions,
  type LeaderReadResult,
  type LeaderValidationResult,
} from "./types.js";

const ARRAY_FIELDS = ["tools", "plugins", "skills", "mcpServers"] as const;
const ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "model",
  "maxContextTokens",
  "maxOutputTokens",
  ...ARRAY_FIELDS,
]);

/**
 * Manages the single global Leader definition at `$PILOT_HOME/leader.md`.
 *
 * Unlike TeammateManager (which scans a directory of many files), this
 * manager handles exactly one file. When the file is absent, all reads
 * return `null` and the runtime falls back to default Leader behaviour.
 */
export class LeaderManager {
  readonly pilotHome: string;
  readonly filePath: string;

  constructor(options: LeaderManagerOptions) {
    if (!options || typeof options.pilotHome !== "string" || !options.pilotHome.trim()) {
      throw new LeaderManagerError("invalid_input", "pilotHome is required.");
    }
    this.pilotHome = resolve(options.pilotHome);
    this.filePath = getPilotLeaderDefinitionFilePath(this.pilotHome);
  }

  async read(): Promise<LeaderReadResult | null> {
    await this.assertSafePath();
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    const validation = this.validate(content);
    if (!validation.ok || !validation.leader) return null;
    return { leader: validation.leader, content, filePath: this.filePath };
  }

  validate(content: string): LeaderValidationResult {
    return parseLeaderDocument(content);
  }

  async write(input: LeaderDocumentInput): Promise<LeaderReadResult> {
    if (!input) {
      throw new LeaderManagerError("invalid_input", "document is required.");
    }
    const content = serializeLeaderDocument(input);
    const validation = this.validate(content);
    if (!validation.ok || !validation.leader) {
      throw new LeaderValidationError(validation);
    }
    await this.assertSafePath();
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await atomicReplace(this.filePath, content);
    return { leader: validation.leader, content, filePath: this.filePath };
  }
  private async assertSafePath(): Promise<void> {
    const unsafeComponent = await findSymlinkComponent(this.pilotHome, this.filePath);
    if (unsafeComponent) {
      throw new LeaderManagerError(
        "unsafe_path",
        `Refusing to access leader definition through symlink: ${unsafeComponent}.`,
      );
    }
  }
}

export class LeaderManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeaderManagerError";
  }
}

export class LeaderValidationError extends LeaderManagerError {
  constructor(public readonly validation: LeaderValidationResult) {
    super("validation_failed", "Leader definition validation failed.");
    this.name = "LeaderValidationError";
  }
}

export function parseLeaderDocument(content: string): LeaderValidationResult {
  const diagnostics: LeaderDiagnostic[] = [];
  if (typeof content !== "string") {
    diagnostics.push(diagnostic("READ_FAILED", "Leader definition content must be a string."));
    return { ok: false, leader: null, diagnostics };
  }

  const raw = content.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*(?:\r?\n|$)/.test(raw)) {
    diagnostics.push(diagnostic("FRONTMATTER_MISSING", "Definition must start with YAML frontmatter."));
    return { ok: false, leader: null, diagnostics };
  }
  const frontmatterMatch = raw.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!frontmatterMatch) {
    diagnostics.push(diagnostic("FRONTMATTER_UNTERMINATED", "YAML frontmatter has no closing delimiter."));
    return { ok: false, leader: null, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterMatch[1]);
  } catch (error) {
    diagnostics.push(
      diagnostic("FRONTMATTER_INVALID", `Invalid YAML frontmatter: ${errorMessage(error)}`),
    );
    return { ok: false, leader: null, diagnostics };
  }
  if (!isRecord(parsed)) {
    diagnostics.push(diagnostic("FRONTMATTER_NOT_OBJECT", "YAML frontmatter must be a mapping."));
    return { ok: false, leader: null, diagnostics };
  }
  for (const field of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(field)) {
      diagnostics.push(
        diagnostic("UNKNOWN_FIELD", `Unknown leader field "${field}".`, { field }),
      );
    }
  }

  validateSchemaVersion(parsed.schemaVersion, diagnostics);
  const model = optionalString(parsed, "model", diagnostics);
  const maxContextTokens = optionalPositiveInteger(parsed, "maxContextTokens", diagnostics);
  const maxOutputTokens = optionalPositiveInteger(parsed, "maxOutputTokens", diagnostics);
  const arrays = Object.fromEntries(
    ARRAY_FIELDS.map((field) => [field, optionalStringArray(parsed, field, diagnostics)]),
  ) as Record<(typeof ARRAY_FIELDS)[number], string[]>;

  const prompt = raw.slice(frontmatterMatch[0].length).trim();
  if (!prompt) {
    diagnostics.push(
      diagnostic("PROMPT_EMPTY", "Markdown body is empty. Leader will use default behaviour only.", {
        field: "prompt",
      }),
    );
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const leader: LeaderDefinition | null = hasErrors
    ? null
    : {
        schemaVersion: LEADER_SCHEMA_VERSION,
        ...(model !== undefined ? { model } : {}),
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        tools: arrays.tools,
        plugins: arrays.plugins,
        skills: arrays.skills,
        mcpServers: arrays.mcpServers,
        prompt: prompt || "",
      };

  return { ok: !hasErrors, leader, diagnostics };
}

export function serializeLeaderDocument(input: LeaderDocumentInput): string {
  const frontmatter: Record<string, unknown> = {
    schemaVersion: input.schemaVersion ?? LEADER_SCHEMA_VERSION,
  };
  if (input.model !== undefined) frontmatter.model = input.model;
  if (input.maxContextTokens !== undefined) frontmatter.maxContextTokens = input.maxContextTokens;
  if (input.maxOutputTokens !== undefined) frontmatter.maxOutputTokens = input.maxOutputTokens;
  for (const field of ARRAY_FIELDS) {
    if (input[field] !== undefined) frontmatter[field] = input[field];
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${prompt}\n`;
}

function validateSchemaVersion(
  value: unknown,
  diagnostics: LeaderDiagnostic[],
): void {
  if (value === undefined) {
    diagnostics.push(
      diagnostic("SCHEMA_VERSION_REQUIRED", "schemaVersion is required.", { field: "schemaVersion" }),
    );
  } else if (typeof value !== "number" || !Number.isInteger(value)) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", "schemaVersion must be the integer 1.", { field: "schemaVersion" }),
    );
  } else if (value !== LEADER_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic("SCHEMA_VERSION_UNSUPPORTED", `Unsupported schemaVersion ${value}; only version 1 is supported.`, {
        field: "schemaVersion",
      }),
    );
  }
}

function optionalString(
  frontmatter: Record<string, unknown>,
  field: string,
  diagnostics: LeaderDiagnostic[],
): string | undefined {
  const value = frontmatter[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    diagnostics.push(diagnostic("FIELD_TYPE_INVALID", `${field} must be a string.`, { field }));
    return undefined;
  }
  return value.trim();
}

function optionalPositiveInteger(
  frontmatter: Record<string, unknown>,
  field: string,
  diagnostics: LeaderDiagnostic[],
): number | undefined {
  const value = frontmatter[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", `${field} must be a positive integer.`, { field }),
    );
    return undefined;
  }
  return Math.floor(value);
}

function optionalStringArray(
  frontmatter: Record<string, unknown>,
  field: string,
  diagnostics: LeaderDiagnostic[],
): string[] {
  const value = frontmatter[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", `${field} must be an array of strings.`, { field }),
    );
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      diagnostics.push(
        diagnostic("FIELD_TYPE_INVALID", `${field}[${index}] must be a non-empty string.`, {
          field: `${field}[${index}]`,
        }),
      );
    } else {
      result.push(item.trim());
    }
  });
  return result;
}

function diagnostic(
  code: LeaderDiagnosticCode,
  message: string,
  details: Omit<LeaderDiagnostic, "code" | "severity" | "message"> = {},
): LeaderDiagnostic {
  const severity: LeaderDiagnostic["severity"] = code === "PROMPT_EMPTY" ? "warning" : "error";
  return { code, severity, message, ...details };
}

async function atomicReplace(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const name = filePath.split(/[\\/]/).pop() ?? "leader.md";
  const temporaryPath = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function findSymlinkComponent(base: string, target: string): Promise<string | null> {
  const fromBase = relative(base, target);
  if (fromBase === ".." || fromBase.startsWith("../") || isAbsolute(fromBase)) {
    return fromBase;
  }
  let current = base;
  for (const part of fromBase.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return relative(base, current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
