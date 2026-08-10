import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  LEADER_WORKSPACE_OVERRIDES_FILE_NAME,
  getPilotLeaderWorkspaceOverridesFilePath,
} from "../../pilot/paths.js";
import { findCanonicalProjectRoot } from "../../session/worktree/findCanonicalProjectRoot.js";
import {
  GlobalTeammateMutationLock,
  getGlobalTeammateMutationLockPath,
} from "../teammates/GlobalTeammateMutationLock.js";
import {
  LEADER_OVERRIDE_SCHEMA_VERSION,
  type LeaderOverrideDocument,
  type LeaderOverrideStoreErrorCode,
  type LeaderOverrideStoreOptions,
  type LeaderToolProfile,
  type LeaderWorkspaceOverride,
} from "./types.js";

/**
 * Per-workspace Leader overrides stored in a single JSON file.
 *
 * Unlike teammate enablement, there is no `enabled` flag — the Leader
 * is always loaded for every workspace. An absent entry simply means
 * "use the global Leader definition as-is".
 */
export class LeaderWorkspaceOverrideStore {
  readonly pilotHome: string;
  readonly filePath: string;
  readonly mutationLock: GlobalTeammateMutationLock;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: LeaderOverrideStoreOptions) {
    if (!options || typeof options.pilotHome !== "string" || !options.pilotHome.trim()) {
      throw new LeaderOverrideStoreError("invalid_input", "pilotHome is required.");
    }
    this.pilotHome = resolve(options.pilotHome);
    this.filePath = getPilotLeaderWorkspaceOverridesFilePath(this.pilotHome);
    this.mutationLock = new GlobalTeammateMutationLock(
      getGlobalTeammateMutationLockPath(this.pilotHome),
    );
  }

  async getOverride(workspace: string): Promise<LeaderWorkspaceOverrideSnapshot> {
    const canonicalWorkspace = await canonicalizeWorkspace(workspace);
    const document = await this.readDocument();
    return {
      canonicalWorkspace,
      override: document.workspaces[canonicalWorkspace]
        ? cloneOverride(document.workspaces[canonicalWorkspace])
        : undefined,
      revision: documentRevision(document),
    };
  }

  async setOverride(
    workspace: string,
    override: LeaderWorkspaceOverride,
    expectedRevision: string,
  ): Promise<LeaderWorkspaceOverrideSnapshot> {
    const normalizedOverride = normalizeOverride(override, "override");
    assertExpectedRevision(expectedRevision);
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const canonicalWorkspace = await canonicalizeWorkspace(workspace);
        const document = await this.readDocument();
        const actualRevision = documentRevision(document);
        if (actualRevision !== expectedRevision) {
          throw new LeaderOverrideStoreError(
            "revision_conflict",
            `Leader workspace overrides changed (expected revision ${expectedRevision}, current revision ${actualRevision}).`,
          );
        }
        document.workspaces[canonicalWorkspace] = normalizedOverride;
        await atomicWriteDocument(this.filePath, document);
        return {
          canonicalWorkspace,
          override: cloneOverride(normalizedOverride),
          revision: documentRevision(document),
        };
      }),
    );
  }

  async deleteOverride(
    workspace: string,
    expectedRevision: string,
  ): Promise<LeaderWorkspaceOverrideSnapshot> {
    assertExpectedRevision(expectedRevision);
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const canonicalWorkspace = await canonicalizeWorkspace(workspace);
        const document = await this.readDocument();
        const actualRevision = documentRevision(document);
        if (actualRevision !== expectedRevision) {
          throw new LeaderOverrideStoreError(
            "revision_conflict",
            `Leader workspace overrides changed (expected revision ${expectedRevision}, current revision ${actualRevision}).`,
          );
        }
        delete document.workspaces[canonicalWorkspace];
        await atomicWriteDocument(this.filePath, document);
        return {
          canonicalWorkspace,
          override: undefined,
          revision: documentRevision(document),
        };
      }),
    );
  }

  private async readDocument(): Promise<LeaderOverrideDocument> {
    await assertSafeStoragePath(this.pilotHome, this.filePath);
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyDocument();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new LeaderOverrideStoreError(
        "invalid_json",
        `Unable to parse leader workspace overrides JSON at ${this.filePath}: ${errorMessage(error)}`,
      );
    }
    return normalizeDocument(parsed, this.filePath);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

export type LeaderWorkspaceOverrideSnapshot = {
  canonicalWorkspace: string;
  override: LeaderWorkspaceOverride | undefined;
  revision: string;
};

export class LeaderOverrideStoreError extends Error {
  constructor(
    public readonly code: LeaderOverrideStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LeaderOverrideStoreError";
  }
}

async function canonicalizeWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new LeaderOverrideStoreError("invalid_input", "workspace is required.");
  }
  const canonical = await findCanonicalProjectRoot(resolve(workspace));
  let physicalPath: string;
  try {
    physicalPath = await realpath(canonical);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    physicalPath = resolve(canonical);
  }
  return normalizeWorkspaceKey(physicalPath);
}

function normalizeWorkspaceKey(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(workspace).normalize("NFC");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyDocument(): LeaderOverrideDocument {
  return { schemaVersion: LEADER_OVERRIDE_SCHEMA_VERSION, workspaces: {} };
}

function normalizeDocument(
  value: unknown,
  filePath: string,
): LeaderOverrideDocument {
  if (!isRecord(value)) {
    throw invalidSchema(filePath, "root must be an object");
  }
  if (value.schemaVersion !== LEADER_OVERRIDE_SCHEMA_VERSION) {
    throw invalidSchema(filePath, `schemaVersion must be ${LEADER_OVERRIDE_SCHEMA_VERSION}`);
  }
  if (!isRecord(value.workspaces)) {
    throw invalidSchema(filePath, "workspaces must be an object");
  }

  const workspaces: Record<string, LeaderWorkspaceOverride> = {};
  for (const [workspace, rawOverride] of Object.entries(value.workspaces)) {
    if (!workspace.trim() || !isAbsolute(workspace)) {
      throw invalidSchema(filePath, `workspace key ${JSON.stringify(workspace)} must be an absolute path`);
    }
    const key = normalizeWorkspaceKey(workspace);
    workspaces[key] = normalizeOverride(rawOverride, `workspaces[${JSON.stringify(workspace)}]`, filePath);
  }
  return {
    schemaVersion: LEADER_OVERRIDE_SCHEMA_VERSION,
    workspaces: Object.fromEntries(
      Object.entries(workspaces).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function normalizeOverride(
  value: unknown,
  field: string,
  filePath?: string,
): LeaderWorkspaceOverride {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  const allowedFields = new Set([
    "model", "maxContextTokens", "maxOutputTokens",
    "toolProfile", "prompt", "plugins", "skills", "mcpServers",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw schemaOrInputError(filePath, `${field} contains unknown field "${key}"`);
    }
  }
  const result: LeaderWorkspaceOverride = {};
  if (value.model !== undefined) {
    if (typeof value.model !== "string") {
      throw schemaOrInputError(filePath, `${field}.model must be a string`);
    }
    result.model = value.model.trim();
  }
  if (value.maxContextTokens !== undefined) {
    if (typeof value.maxContextTokens !== "number" || !Number.isInteger(value.maxContextTokens) || value.maxContextTokens <= 0) {
      throw schemaOrInputError(filePath, `${field}.maxContextTokens must be a positive integer`);
    }
    result.maxContextTokens = value.maxContextTokens;
  }
  if (value.maxOutputTokens !== undefined) {
    if (typeof value.maxOutputTokens !== "number" || !Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0) {
      throw schemaOrInputError(filePath, `${field}.maxOutputTokens must be a positive integer`);
    }
    result.maxOutputTokens = value.maxOutputTokens;
  }
  if (value.toolProfile !== undefined) {
    result.toolProfile = normalizeToolProfile(value.toolProfile, `${field}.toolProfile`, filePath);
  }
  if (value.prompt !== undefined) {
    if (typeof value.prompt !== "string") {
      throw schemaOrInputError(filePath, `${field}.prompt must be a string`);
    }
    result.prompt = value.prompt;
  }
  for (const arrayField of ["plugins", "skills", "mcpServers"] as const) {
    if (value[arrayField] !== undefined) {
      if (!Array.isArray(value[arrayField]) || !value[arrayField].every((item: unknown) => typeof item === "string" && (item as string).trim())) {
        throw schemaOrInputError(filePath, `${field}.${arrayField} must be an array of non-empty strings`);
      }
      result[arrayField] = [...new Set((value[arrayField] as string[]).map((s: string) => s.trim()))];
    }
  }
  return result;
}

function normalizeToolProfile(
  value: unknown,
  field: string,
  filePath?: string,
): LeaderToolProfile {
  if (!isRecord(value) || (value.mode !== "inherit" && value.mode !== "custom")) {
    throw schemaOrInputError(filePath, `${field}.mode must be "inherit" or "custom"`);
  }
  if (value.mode === "inherit") return { mode: "inherit" };
  if (
    !Array.isArray(value.tools) ||
    !value.tools.every((tool: unknown) => typeof tool === "string" && (tool as string).trim())
  ) {
    throw schemaOrInputError(filePath, `${field}.tools must be an array of non-empty strings`);
  }
  return {
    mode: "custom",
    tools: [...new Set((value.tools as string[]).map((s: string) => s.trim()))].sort(),
  };
}

function cloneOverride(override: LeaderWorkspaceOverride): LeaderWorkspaceOverride {
  return structuredClone(override);
}

function documentRevision(document: LeaderOverrideDocument): string {
  const canonical = {
    schemaVersion: document.schemaVersion,
    workspaces: Object.fromEntries(
      Object.entries(document.workspaces)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertExpectedRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new LeaderOverrideStoreError(
      "invalid_input",
      "expectedRevision must be a SHA-256 revision returned by getOverride.",
    );
  }
}

async function atomicWriteDocument(
  filePath: string,
  document: LeaderOverrideDocument,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(
    directory,
    `.${LEADER_WORKSPACE_OVERRIDES_FILE_NAME}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertSafeStoragePath(
  pilotHome: string,
  filePath: string,
): Promise<void> {
  const fromHome = relative(pilotHome, filePath);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new LeaderOverrideStoreError("unsafe_path", "Leader overrides path leaves PILOT_HOME.");
  }
  let current = pilotHome;
  for (const part of fromHome.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new LeaderOverrideStoreError(
          "unsafe_path",
          `Refusing to access leader overrides through symlink: ${relative(pilotHome, current)}.`,
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }
}

function invalidSchema(filePath: string, reason: string): LeaderOverrideStoreError {
  return new LeaderOverrideStoreError(
    "invalid_schema",
    `Invalid leader workspace overrides schema at ${filePath}: ${reason}.`,
  );
}

function schemaOrInputError(filePath: string | undefined, reason: string): LeaderOverrideStoreError {
  return filePath
    ? invalidSchema(filePath, reason)
    : new LeaderOverrideStoreError("invalid_input", `${reason}.`);
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
