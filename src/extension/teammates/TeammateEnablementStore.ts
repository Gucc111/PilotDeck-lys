import { randomUUID } from "node:crypto";
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
  TEAMMATE_ENABLEMENT_FILE_NAME,
  getPilotTeammateEnablementFilePath,
} from "../../pilot/paths.js";
import { findCanonicalProjectRoot } from "../../session/worktree/findCanonicalProjectRoot.js";
import {
  GlobalTeammateMutationLock,
  getGlobalTeammateMutationLockPath,
} from "./GlobalTeammateMutationLock.js";
import { isValidTeammateId } from "./teammateId.js";
import {
  TEAMMATE_ENABLEMENT_SCHEMA_VERSION,
  type TeammateEnablementDocument,
  type TeammateEnablementStoreErrorCode,
  type TeammateEnablementStoreOptions,
} from "./types.js";

/**
 * Stores the complete enabled teammate ID set for each canonical workspace.
 *
 * Definitions remain global. This file only controls which global definitions
 * a workspace may use, and an absent workspace always means no teammates.
 */
export class TeammateEnablementStore {
  readonly pilotHome: string;
  readonly filePath: string;
  readonly mutationLock: GlobalTeammateMutationLock;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: TeammateEnablementStoreOptions) {
    if (!options || typeof options.pilotHome !== "string" || !options.pilotHome.trim()) {
      throw new TeammateEnablementStoreError(
        "invalid_input",
        "pilotHome is required.",
      );
    }
    this.pilotHome = resolve(options.pilotHome);
    this.filePath = getPilotTeammateEnablementFilePath(this.pilotHome);
    this.mutationLock = new GlobalTeammateMutationLock(
      getGlobalTeammateMutationLockPath(this.pilotHome),
    );
  }

  async get(workspace: string): Promise<string[]> {
    const key = await canonicalizeTeammateWorkspace(workspace);
    const document = await this.readDocument();
    return [...(document.workspaces[key] ?? [])];
  }

  async list(): Promise<TeammateEnablementDocument> {
    return this.readDocument();
  }

  async set(workspace: string, enabledIds: string[]): Promise<string[]> {
    const normalizedIds = normalizeEnabledIds(enabledIds, "enabledIds");
    return this.runMutation((mutation) => mutation.set(workspace, normalizedIds));
  }

  /**
   * Remove a teammate ID from every workspace. Returns whether the file changed.
   */
  async prune(teammateId: string): Promise<boolean> {
    assertValidTeammateId(teammateId);
    return this.runMutation((mutation) => mutation.prune(teammateId));
  }

  /**
   * Queue an enablement mutation and run it while holding the shared global
   * teammate lock. Manager transactions use this to avoid nested lock
   * acquisition while keeping definition validation and enablement writes
   * in one cross-process critical section.
   */
  async runMutation<T>(
    operation: (mutation: TeammateEnablementMutation) => Promise<T>,
  ): Promise<T> {
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(() =>
        operation({
          set: (workspace, enabledIds) =>
            this.setWithinMutation(workspace, enabledIds),
          prune: (teammateId) => this.pruneWithinMutation(teammateId),
        })),
    );
  }

  private async setWithinMutation(
    workspace: string,
    enabledIds: string[],
  ): Promise<string[]> {
    const normalizedIds = normalizeEnabledIds(enabledIds, "enabledIds");
    const key = await canonicalizeTeammateWorkspace(workspace);
    const document = await this.readDocument();
    document.workspaces[key] = normalizedIds;
    await atomicWriteDocument(this.filePath, document);
    return [...normalizedIds];
  }

  private async pruneWithinMutation(teammateId: string): Promise<boolean> {
    assertValidTeammateId(teammateId);
    const document = await this.readDocument();
    let changed = false;
    for (const [workspace, enabledIds] of Object.entries(document.workspaces)) {
      const next = enabledIds.filter((id) => id !== teammateId);
      if (next.length !== enabledIds.length) {
        document.workspaces[workspace] = next;
        changed = true;
      }
    }
    if (changed) {
      await atomicWriteDocument(this.filePath, document);
    }
    return changed;
  }

  private async readDocument(): Promise<TeammateEnablementDocument> {
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
      throw new TeammateEnablementStoreError(
        "invalid_json",
        `Unable to parse teammate workspace enablement JSON at ${this.filePath}: ${errorMessage(error)}`,
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

export type TeammateEnablementMutation = {
  set(workspace: string, enabledIds: string[]): Promise<string[]>;
  prune(teammateId: string): Promise<boolean>;
};

export class TeammateEnablementStoreError extends Error {
  constructor(
    public readonly code: TeammateEnablementStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeammateEnablementStoreError";
  }
}

export async function canonicalizeTeammateWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new TeammateEnablementStoreError(
      "invalid_input",
      "workspace is required.",
    );
  }
  const canonical = await findCanonicalProjectRoot(resolve(workspace));
  let physicalPath: string;
  try {
    physicalPath = await realpath(canonical);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    physicalPath = resolve(canonical);
  }
  return normalizeTeammateWorkspaceKey(physicalPath);
}

export function normalizeTeammateWorkspaceKey(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(workspace).normalize("NFC");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function emptyDocument(): TeammateEnablementDocument {
  return {
    schemaVersion: TEAMMATE_ENABLEMENT_SCHEMA_VERSION,
    workspaces: {},
  };
}

function normalizeDocument(
  value: unknown,
  filePath: string,
): TeammateEnablementDocument {
  if (!isRecord(value)) {
    throw invalidSchema(filePath, "root must be an object");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 2 ||
    !fields.includes("schemaVersion") ||
    !fields.includes("workspaces")
  ) {
    throw invalidSchema(
      filePath,
      "root must contain only schemaVersion and workspaces",
    );
  }
  if (value.schemaVersion !== TEAMMATE_ENABLEMENT_SCHEMA_VERSION) {
    throw invalidSchema(
      filePath,
      `schemaVersion must be ${TEAMMATE_ENABLEMENT_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(value.workspaces)) {
    throw invalidSchema(filePath, "workspaces must be an object");
  }

  const workspaces: Record<string, string[]> = {};
  for (const [workspace, enabledIds] of Object.entries(value.workspaces)) {
    if (!workspace.trim() || !isAbsolute(workspace)) {
      throw invalidSchema(
        filePath,
        `workspace key ${JSON.stringify(workspace)} must be an absolute path`,
      );
    }
    const key = normalizeTeammateWorkspaceKey(workspace);
    const normalizedIds = normalizeEnabledIds(
      enabledIds,
      `workspaces[${JSON.stringify(workspace)}]`,
      filePath,
    );
    workspaces[key] = normalizeEnabledIds([
      ...(workspaces[key] ?? []),
      ...normalizedIds,
    ], `workspaces[${JSON.stringify(workspace)}]`, filePath);
  }
  return {
    schemaVersion: TEAMMATE_ENABLEMENT_SCHEMA_VERSION,
    workspaces,
  };
}

function normalizeEnabledIds(
  value: unknown,
  field: string,
  filePath?: string,
): string[] {
  if (!Array.isArray(value)) {
    throw filePath
      ? invalidSchema(filePath, `${field} must be an array of strings`)
      : new TeammateEnablementStoreError(
          "invalid_input",
          `${field} must be an array of teammate IDs.`,
        );
  }
  for (const id of value) {
    if (typeof id !== "string" || !isValidTeammateId(id)) {
      throw filePath
        ? invalidSchema(filePath, `${field} contains an invalid teammate ID`)
        : new TeammateEnablementStoreError(
            "invalid_input",
            `${field} contains an invalid teammate ID.`,
          );
    }
  }
  return [...new Set(value)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function assertValidTeammateId(id: unknown): asserts id is string {
  if (!isValidTeammateId(id)) {
    throw new TeammateEnablementStoreError(
      "invalid_input",
      "teammateId must be a valid teammate ID.",
    );
  }
}

async function atomicWriteDocument(
  filePath: string,
  document: TeammateEnablementDocument,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(
    directory,
    `.${TEAMMATE_ENABLEMENT_FILE_NAME}.${randomUUID()}.tmp`,
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
  if (
    fromHome === ".." ||
    fromHome.startsWith(`..${sep}`) ||
    isAbsolute(fromHome)
  ) {
    throw new TeammateEnablementStoreError(
      "unsafe_path",
      "Teammate enablement path leaves PILOT_HOME.",
    );
  }
  let current = pilotHome;
  for (const part of fromHome.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new TeammateEnablementStoreError(
          "unsafe_path",
          `Refusing to access teammate enablement through symlink: ${relative(pilotHome, current)}.`,
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }
}

function invalidSchema(
  filePath: string,
  reason: string,
): TeammateEnablementStoreError {
  return new TeammateEnablementStoreError(
    "invalid_schema",
    `Invalid teammate workspace enablement schema at ${filePath}: ${reason}.`,
  );
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
