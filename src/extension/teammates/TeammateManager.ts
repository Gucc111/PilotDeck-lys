import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { getPilotTeammatesDir } from "../../pilot/paths.js";
import { TeammateEnablementStore } from "./TeammateEnablementStore.js";
import { isValidTeammateId } from "./teammateId.js";
import {
  TEAMMATE_SCHEMA_VERSION,
  type TeammateCreateInput,
  type TeammateDefinition,
  type TeammateDeleteResult,
  type TeammateDiagnostic,
  type TeammateDiagnosticCode,
  type TeammateDocumentInput,
  type TeammateListResult,
  type TeammateManagerOptions,
  type TeammateReadResult,
  type TeammateRecord,
  type TeammateValidationResult,
  type TeammateWriteInput,
} from "./types.js";

const ARRAY_FIELDS = ["tools", "plugins", "skills", "mcpServers"] as const;
const ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "id",
  "name",
  "description",
  "model",
  ...ARRAY_FIELDS,
]);

type ParsedDocument = {
  result: TeammateValidationResult;
  candidateId: string | null;
};

type ScannedFile = {
  candidateId: string | null;
  relativePath: string;
  record: TeammateRecord | null;
};

/**
 * Global storage for teammate definitions.
 *
 * Every operation is rooted at `$PILOT_HOME/teammates`. Workspace-local
 * `.pilotdeck/teammates` directories are never inspected or used as fallback.
 */
export class TeammateManager {
  readonly pilotHome: string;
  readonly teammatesRoot: string;
  readonly enablementStore: TeammateEnablementStore;

  constructor(options: TeammateManagerOptions) {
    if (!options || typeof options.pilotHome !== "string" || !options.pilotHome.trim()) {
      throw new TeammateManagerError("invalid_input", "pilotHome is required.");
    }
    this.pilotHome = resolve(options.pilotHome);
    this.teammatesRoot = getPilotTeammatesDir(this.pilotHome);
    this.enablementStore = new TeammateEnablementStore({
      pilotHome: this.pilotHome,
    });
  }

  async list(): Promise<TeammateListResult> {
    const diagnostics: TeammateDiagnostic[] = [];
    const files: ScannedFile[] = [];
    const unsafeComponent = await findSymlinkComponent(this.pilotHome, this.teammatesRoot);
    if (unsafeComponent) {
      diagnostics.push(
        diagnostic(
          "UNSAFE_SYMLINK",
          `Refusing to scan teammate storage through symlink: ${unsafeComponent}.`,
          { relativePath: unsafeComponent },
        ),
      );
      return { teammates: [], diagnostics };
    }

    let rootStat: import("node:fs").Stats;
    try {
      rootStat = await fs.lstat(this.teammatesRoot);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { teammates: [], diagnostics: [] };
      throw error;
    }
    if (!rootStat.isDirectory()) {
      diagnostics.push(
        diagnostic("ROOT_NOT_DIRECTORY", "Global teammate path is not a directory."),
      );
      return { teammates: [], diagnostics };
    }

    await this.scanDirectory(this.teammatesRoot, "", files, diagnostics);
    addDuplicateDiagnostics(files, diagnostics);

    const teammates = files
      .flatMap((file) => (file.record ? [file.record] : []))
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.relativePath.localeCompare(right.relativePath),
      );
    return { teammates, diagnostics };
  }

  async get(id: string): Promise<TeammateRecord | null> {
    return this.findUniqueRecord(id);
  }

  async read(id: string): Promise<TeammateReadResult | null> {
    const teammate = await this.findUniqueRecord(id);
    if (!teammate) return null;
    await this.assertSafeTarget(teammate.filePath);
    return {
      teammate,
      content: await fs.readFile(teammate.filePath, "utf8"),
    };
  }

  validate(content: string, relativePath?: string): TeammateValidationResult {
    return parseTeammateDocument(content, relativePath).result;
  }

  async create(input: TeammateCreateInput): Promise<TeammateReadResult> {
    if (!input || !input.document) {
      throw new TeammateManagerError("invalid_input", "document is required.");
    }
    const content = renderTeammateDocument(input.document);
    const validation = this.validate(content, input.relativePath);
    if (!validation.ok || !validation.teammate) {
      throw new TeammateValidationError(validation);
    }
    const teammate = validation.teammate;

    const relativePath = normalizeDefinitionPath(
      input.relativePath ?? `${teammate.id}.md`,
    );
    const filePath = this.resolveDefinitionPath(relativePath);
    return this.enablementStore.mutationLock.runExclusive(async () => {
      const listed = await this.list();
      const idAlreadyDeclared =
        listed.teammates.some((listedTeammate) => listedTeammate.id === teammate.id) ||
        listed.diagnostics.some((item) => item.id === teammate.id);
      if (idAlreadyDeclared) {
        throw new TeammateManagerError(
          "conflict",
          `Teammate id "${teammate.id}" already exists.`,
        );
      }

      await this.assertSafeTarget(filePath);
      await fs.mkdir(resolve(filePath, ".."), { recursive: true });
      await atomicCreate(filePath, content);
      return {
        teammate: {
          ...teammate,
          relativePath,
          filePath,
        },
        content,
      };
    });
  }

  async write(input: TeammateWriteInput): Promise<TeammateReadResult> {
    if (!input || !input.document) {
      throw new TeammateManagerError("invalid_input", "id and document are required.");
    }
    assertValidId(input.id);
    const content = renderTeammateDocument(input.document);
    return this.enablementStore.mutationLock.runExclusive(async () => {
      const existing = await this.findUniqueRecord(input.id);
      if (!existing) {
        throw new TeammateManagerError("not_found", `Teammate "${input.id}" was not found.`);
      }

      const validation = this.validate(content, existing.relativePath);
      if (!validation.ok || !validation.teammate) {
        throw new TeammateValidationError(validation);
      }
      if (validation.teammate.id !== input.id) {
        throw new TeammateManagerError(
          "id_mismatch",
          `Definition id "${validation.teammate.id}" does not match target id "${input.id}".`,
        );
      }

      await this.assertSafeTarget(existing.filePath);
      await atomicReplace(existing.filePath, content);
      return {
        teammate: {
          ...validation.teammate,
          relativePath: existing.relativePath,
          filePath: existing.filePath,
        },
        content,
      };
    });
  }

  async delete(id: string): Promise<TeammateDeleteResult> {
    assertValidId(id);
    return this.enablementStore.runMutation(async (mutation) => {
      const existing = await this.findUniqueRecord(id);
      if (!existing) {
        throw new TeammateManagerError("not_found", `Teammate "${id}" was not found.`);
      }
      await this.assertSafeTarget(existing.filePath);
      const tombstonePath = join(
        resolve(existing.filePath, ".."),
        `.${filePathName(existing.filePath)}.${randomUUID()}.deleted`,
      );
      await fs.rename(existing.filePath, tombstonePath);
      try {
        await mutation.prune(id);
      } catch (error) {
        try {
          await fs.rename(tombstonePath, existing.filePath);
        } catch (restoreError) {
          throw new TeammateManagerError(
            "delete_recovery_failed",
            `Unable to restore teammate "${id}" after delete failed: ${errorMessage(
              restoreError,
            )}. Original error: ${errorMessage(error)}.`,
          );
        }
        throw error;
      }
      // The definition is already absent from discovery and its enablement
      // references are committed. Tombstone cleanup is best-effort so a
      // transient unlink failure cannot resurrect a globally disabled file.
      await fs.unlink(tombstonePath).catch(() => undefined);
      return { ok: true, id, relativePath: existing.relativePath };
    });
  }

  async getEnablement(workspace: string): Promise<string[]> {
    return this.enablementStore.get(workspace);
  }

  async setEnablement(workspace: string, enabledIds: string[]): Promise<string[]> {
    if (!Array.isArray(enabledIds)) {
      throw new TeammateManagerError(
        "invalid_input",
        "enabledIds must be a complete array of teammate IDs.",
      );
    }
    return this.enablementStore.runMutation(async (mutation) => {
      const listed = await this.list();
      const invalidDefinitionIds = new Set(
        listed.diagnostics
          .filter((item) => item.severity === "error" && item.id)
          .map((item) => item.id as string),
      );
      const validIds = new Set(
        listed.teammates
          .filter((teammate) => !invalidDefinitionIds.has(teammate.id))
          .map((teammate) => teammate.id),
      );
      const normalizedIds = [...new Set(enabledIds)];
      const unknownIds = normalizedIds.filter((teammateId) =>
        !validIds.has(teammateId)).sort();
      if (unknownIds.length > 0) {
        throw new TeammateManagerError(
          "invalid_input",
          `Unknown or invalid teammate IDs: ${unknownIds.join(", ")}.`,
        );
      }
      return mutation.set(workspace, normalizedIds);
    });
  }

  private async scanDirectory(
    directory: string,
    relativeDirectory: string,
    files: ScannedFile[],
    diagnostics: TeammateDiagnostic[],
  ): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(
        diagnostic("READ_FAILED", `Unable to read teammate directory: ${errorMessage(error)}`, {
          relativePath: relativeDirectory || undefined,
        }),
      );
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name;
      const filePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push(
          diagnostic("UNSAFE_SYMLINK", "Symlinks are not followed in teammate storage.", {
            relativePath,
          }),
        );
        continue;
      }
      if (entry.isDirectory()) {
        await this.scanDirectory(filePath, relativePath, files, diagnostics);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        diagnostics.push(
          diagnostic("READ_FAILED", `Unable to read teammate definition: ${errorMessage(error)}`, {
            relativePath,
          }),
        );
        continue;
      }

      const parsed = parseTeammateDocument(content, relativePath);
      diagnostics.push(...parsed.result.diagnostics);
      files.push({
        candidateId: parsed.candidateId,
        relativePath,
        record: parsed.result.teammate
          ? {
              ...parsed.result.teammate,
              relativePath,
              filePath,
            }
          : null,
      });
    }
  }

  private async findUniqueRecord(id: string): Promise<TeammateRecord | null> {
    assertValidId(id);
    const listed = await this.list();
    const matches = listed.teammates.filter((teammate) => teammate.id === id);
    const duplicatePaths = listed.diagnostics
      .filter((item) => item.code === "DUPLICATE_ID" && item.id === id)
      .flatMap((item) => [item.relativePath, ...(item.relatedPaths ?? [])])
      .filter((item): item is string => Boolean(item));
    if (duplicatePaths.length > 0) {
      throw new TeammateManagerError(
        "duplicate_id",
        `Teammate id "${id}" is defined by multiple files: ${[
          ...new Set(duplicatePaths),
        ].join(", ")}.`,
      );
    }
    return matches[0] ?? null;
  }

  private resolveDefinitionPath(relativePath: string): string {
    const filePath = resolve(this.teammatesRoot, ...relativePath.split("/"));
    const fromRoot = relative(this.teammatesRoot, filePath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${pathSeparator()}`) || isAbsolute(fromRoot)) {
      throw new TeammateManagerError("unsafe_path", "Definition path leaves teammate storage.");
    }
    return filePath;
  }

  private async assertSafeTarget(filePath: string): Promise<void> {
    const unsafeComponent = await findSymlinkComponent(this.pilotHome, filePath);
    if (unsafeComponent) {
      throw new TeammateManagerError(
        "unsafe_path",
        `Refusing to access teammate storage through symlink: ${unsafeComponent}.`,
      );
    }
  }
}

export class TeammateManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeammateManagerError";
  }
}

export class TeammateValidationError extends TeammateManagerError {
  constructor(public readonly validation: TeammateValidationResult) {
    super("validation_failed", "Teammate definition validation failed.");
    this.name = "TeammateValidationError";
  }
}

function assertValidId(id: unknown): asserts id is string {
  if (!isValidTeammateId(id)) {
    throw new TeammateManagerError(
      "invalid_id",
      "Invalid teammate id. Use 1-100 ASCII letters, digits, dots, underscores, or hyphens; " +
        "start and end with a letter or digit and do not use '..'.",
    );
  }
}

function parseTeammateDocument(content: string, relativePath?: string): ParsedDocument {
  const diagnostics: TeammateDiagnostic[] = [];
  if (typeof content !== "string") {
    diagnostics.push(
      diagnostic("READ_FAILED", "Teammate definition content must be a string.", {
        relativePath,
      }),
    );
    return validationResult(null, null, diagnostics);
  }

  const raw = content.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*(?:\r?\n|$)/.test(raw)) {
    diagnostics.push(
      diagnostic("FRONTMATTER_MISSING", "Definition must start with YAML frontmatter.", {
        relativePath,
      }),
    );
    return validationResult(null, null, diagnostics);
  }
  const frontmatterMatch = raw.match(
    /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m,
  );
  if (!frontmatterMatch) {
    diagnostics.push(
      diagnostic("FRONTMATTER_UNTERMINATED", "YAML frontmatter has no closing delimiter.", {
        relativePath,
      }),
    );
    return validationResult(null, null, diagnostics);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterMatch[1]);
  } catch (error) {
    diagnostics.push(
      diagnostic("FRONTMATTER_INVALID", `Invalid YAML frontmatter: ${errorMessage(error)}`, {
        relativePath,
      }),
    );
    return validationResult(null, null, diagnostics);
  }
  if (!isRecord(parsed)) {
    diagnostics.push(
      diagnostic("FRONTMATTER_NOT_OBJECT", "YAML frontmatter must be a mapping.", {
        relativePath,
      }),
    );
    return validationResult(null, null, diagnostics);
  }
  for (const field of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(field)) {
      diagnostics.push(
        diagnostic("UNKNOWN_FIELD", `Unknown teammate field "${field}".`, {
          relativePath,
          field,
          ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
        }),
      );
    }
  }

  validateSchemaVersion(parsed.schemaVersion, diagnostics, relativePath);
  const candidateId = resolveCandidateId(parsed, diagnostics, relativePath);
  const name = validateName(parsed.name, candidateId, diagnostics, relativePath);
  const description = optionalString(parsed, "description", diagnostics, relativePath);
  const model = optionalString(parsed, "model", diagnostics, relativePath);
  const arrays = Object.fromEntries(
    ARRAY_FIELDS.map((field) => [
      field,
      optionalStringArray(parsed, field, diagnostics, relativePath),
    ]),
  ) as Record<(typeof ARRAY_FIELDS)[number], string[]>;

  const prompt = raw.slice(frontmatterMatch[0].length).trim();
  if (!prompt) {
    diagnostics.push(
      diagnostic("PROMPT_REQUIRED", "Markdown body must contain a teammate prompt.", {
        relativePath,
        field: "prompt",
        id: candidateId ?? undefined,
      }),
    );
  }
  if (candidateId) {
    for (const item of diagnostics) {
      item.id ??= candidateId;
    }
  }

  const teammate =
    diagnostics.some((item) => item.severity === "error") ||
    !candidateId ||
    !name ||
    !prompt
      ? null
      : {
          schemaVersion: TEAMMATE_SCHEMA_VERSION,
          id: candidateId,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(model !== undefined ? { model } : {}),
          tools: arrays.tools,
          plugins: arrays.plugins,
          skills: arrays.skills,
          mcpServers: arrays.mcpServers,
          prompt,
        };
  return validationResult(teammate, candidateId, diagnostics);
}

function validateSchemaVersion(
  value: unknown,
  diagnostics: TeammateDiagnostic[],
  relativePath?: string,
): void {
  if (value === undefined) {
    diagnostics.push(
      diagnostic("SCHEMA_VERSION_REQUIRED", "schemaVersion is required.", {
        relativePath,
        field: "schemaVersion",
      }),
    );
  } else if (typeof value !== "number" || !Number.isInteger(value)) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", "schemaVersion must be the integer 1.", {
        relativePath,
        field: "schemaVersion",
      }),
    );
  } else if (value !== TEAMMATE_SCHEMA_VERSION) {
    diagnostics.push(
      diagnostic(
        "SCHEMA_VERSION_UNSUPPORTED",
        `Unsupported schemaVersion ${value}; only version 1 is supported.`,
        { relativePath, field: "schemaVersion" },
      ),
    );
  }
}

function resolveCandidateId(
  frontmatter: Record<string, unknown>,
  diagnostics: TeammateDiagnostic[],
  relativePath?: string,
): string | null {
  const hasExplicitId = Object.hasOwn(frontmatter, "id");
  const rawId = hasExplicitId ? frontmatter.id : frontmatter.name;
  if (rawId === undefined) {
    diagnostics.push(
      diagnostic("ID_REQUIRED", "Provide an explicit id or use name as the stable id.", {
        relativePath,
        field: "id",
      }),
    );
    return null;
  }
  if (typeof rawId !== "string") {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", `${hasExplicitId ? "id" : "name"} must be a string.`, {
        relativePath,
        field: hasExplicitId ? "id" : "name",
      }),
    );
    return null;
  }
  const id = rawId.trim();
  if (!isValidTeammateId(id)) {
    diagnostics.push(
      diagnostic(
        "ID_INVALID",
        `Invalid teammate id "${id}". Use a safe 1-100 character identifier without path separators or '..'.`,
        { relativePath, field: hasExplicitId ? "id" : "name", id: id || undefined },
      ),
    );
    return null;
  }
  return id;
}

function validateName(
  value: unknown,
  candidateId: string | null,
  diagnostics: TeammateDiagnostic[],
  relativePath?: string,
): string | null {
  if (value === undefined) return candidateId;
  if (typeof value !== "string") {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", "name must be a string.", {
        relativePath,
        field: "name",
        id: candidateId ?? undefined,
      }),
    );
    return null;
  }
  const name = value.trim();
  if (!name) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", "name must not be empty.", {
        relativePath,
        field: "name",
        id: candidateId ?? undefined,
      }),
    );
    return null;
  }
  return name;
}

function optionalString(
  frontmatter: Record<string, unknown>,
  field: "description" | "model",
  diagnostics: TeammateDiagnostic[],
  relativePath?: string,
): string | undefined {
  const value = frontmatter[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", `${field} must be a string.`, {
        relativePath,
        field,
      }),
    );
    return undefined;
  }
  return value.trim();
}

function optionalStringArray(
  frontmatter: Record<string, unknown>,
  field: (typeof ARRAY_FIELDS)[number],
  diagnostics: TeammateDiagnostic[],
  relativePath?: string,
): string[] {
  const value = frontmatter[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic("FIELD_TYPE_INVALID", `${field} must be an array of strings.`, {
        relativePath,
        field,
      }),
    );
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      diagnostics.push(
        diagnostic("FIELD_TYPE_INVALID", `${field}[${index}] must be a non-empty string.`, {
          relativePath,
          field: `${field}[${index}]`,
        }),
      );
    } else {
      result.push(item.trim());
    }
  });
  return result;
}

function renderTeammateDocument(input: TeammateDocumentInput): string {
  const frontmatter: Record<string, unknown> = {
    schemaVersion: input.schemaVersion ?? TEAMMATE_SCHEMA_VERSION,
  };
  if (input.id !== undefined) frontmatter.id = input.id;
  if (input.name !== undefined) frontmatter.name = input.name;
  if (input.description !== undefined) frontmatter.description = input.description;
  if (input.model !== undefined) frontmatter.model = input.model;
  for (const field of ARRAY_FIELDS) {
    if (input[field] !== undefined) frontmatter[field] = input[field];
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${prompt}\n`;
}

function addDuplicateDiagnostics(
  files: ScannedFile[],
  diagnostics: TeammateDiagnostic[],
): void {
  const pathsById = new Map<string, string[]>();
  for (const file of files) {
    if (!file.candidateId) continue;
    const paths = pathsById.get(file.candidateId) ?? [];
    paths.push(file.relativePath);
    pathsById.set(file.candidateId, paths);
  }
  for (const [id, paths] of pathsById) {
    if (paths.length < 2) continue;
    const sortedPaths = [...paths].sort();
    for (const relativePath of sortedPaths) {
      diagnostics.push(
        diagnostic("DUPLICATE_ID", `Teammate id "${id}" is defined more than once.`, {
          id,
          relativePath,
          relatedPaths: sortedPaths.filter((path) => path !== relativePath),
        }),
      );
    }
  }
}

function validationResult(
  teammate: TeammateDefinition | null,
  candidateId: string | null,
  diagnostics: TeammateDiagnostic[],
): ParsedDocument {
  return {
    candidateId,
    result: {
      ok: teammate !== null && !diagnostics.some((item) => item.severity === "error"),
      teammate,
      diagnostics,
    },
  };
}

function normalizeDefinitionPath(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new TeammateManagerError("unsafe_path", "Definition path must be a relative POSIX path.");
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    extname(parts.at(-1) ?? "").toLowerCase() !== ".md"
  ) {
    throw new TeammateManagerError(
      "unsafe_path",
      "Definition path must point to a .md file below teammate storage.",
    );
  }
  return parts.join("/");
}

async function findSymlinkComponent(base: string, target: string): Promise<string | null> {
  const fromBase = relative(base, target);
  if (fromBase === ".." || fromBase.startsWith(`..${pathSeparator()}`) || isAbsolute(fromBase)) {
    return fromBase;
  }
  let current = base;
  for (const part of fromBase.split(pathSeparator()).filter(Boolean)) {
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

async function atomicReplace(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(
    resolve(filePath, ".."),
    `.${filePathName(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function atomicCreate(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(
    resolve(filePath, ".."),
    `.${filePathName(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new TeammateManagerError("conflict", `Definition file already exists: ${filePath}`);
      }
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function diagnostic(
  code: TeammateDiagnosticCode,
  message: string,
  details: Omit<TeammateDiagnostic, "code" | "severity" | "message"> = {},
): TeammateDiagnostic {
  return { code, severity: "error", message, ...details };
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

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function filePathName(filePath: string): string {
  const parts = filePath.split(pathSeparator());
  return parts[parts.length - 1] ?? "teammate.md";
}
