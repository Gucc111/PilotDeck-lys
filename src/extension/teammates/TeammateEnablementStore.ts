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
  type TeammateContextPolicy,
  type TeammateEnablementDocument,
  type TeammateEnablementStoreErrorCode,
  type TeammateEnablementStoreOptions,
  type TeammateWorkspaceBinding,
} from "./types.js";
import type {
  ToolCallCondition,
  ToolCallSelector,
} from "../../permission/index.js";

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
    const { bindings } = await this.getBindings(workspace);
    return Object.entries(bindings)
      .filter(([, binding]) => binding.enabled)
      .map(([id]) => id);
  }

  async getBindings(workspace: string): Promise<TeammateWorkspaceBindingsSnapshot> {
    const canonicalWorkspace = await canonicalizeTeammateWorkspace(workspace);
    const document = await this.readDocument();
    return {
      canonicalWorkspace,
      bindings: cloneBindings(document.workspaces[canonicalWorkspace] ?? {}),
      revision: documentRevision(document),
    };
  }

  async getBinding(
    workspace: string,
    teammateId: string,
  ): Promise<TeammateWorkspaceBindingSnapshot> {
    assertValidTeammateId(teammateId);
    const snapshot = await this.getBindings(workspace);
    return {
      canonicalWorkspace: snapshot.canonicalWorkspace,
      binding: snapshot.bindings[teammateId],
      revision: snapshot.revision,
    };
  }

  async list(): Promise<TeammateEnablementDocument> {
    return this.readDocument();
  }

  async set(workspace: string, enabledIds: string[]): Promise<string[]> {
    const normalizedIds = normalizeEnabledIds(enabledIds, "enabledIds");
    return this.runMutation((mutation) => mutation.set(workspace, normalizedIds));
  }

  async setBinding(
    workspace: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
    expectedRevision: string,
  ): Promise<TeammateWorkspaceBindingsSnapshot> {
    assertValidTeammateId(teammateId);
    const normalizedBinding = normalizeBinding(binding, "binding");
    assertExpectedRevision(expectedRevision);
    return this.runMutation((mutation) =>
      mutation.setBinding(
        workspace,
        teammateId,
        normalizedBinding,
        expectedRevision,
      ));
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
          setBinding: (workspace, teammateId, binding, expectedRevision) =>
            this.setBindingWithinMutation(
              workspace,
              teammateId,
              binding,
              expectedRevision,
            ),
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
    const current = document.workspaces[key] ?? {};
    const enabledSet = new Set(normalizedIds);
    const next = Object.fromEntries(
      Object.entries(current)
        .filter(([id, binding]) =>
          enabledSet.has(id) || binding.toolProfile.mode === "custom")
        .map(([id, binding]) => [
          id,
          { ...binding, enabled: enabledSet.has(id) },
        ]),
    );
    for (const id of normalizedIds) {
      if (!next[id]) next[id] = inheritBinding(true);
    }
    document.workspaces[key] = next;
    await atomicWriteDocument(this.filePath, document);
    return [...normalizedIds];
  }

  private async setBindingWithinMutation(
    workspace: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
    expectedRevision: string,
  ): Promise<TeammateWorkspaceBindingsSnapshot> {
    assertValidTeammateId(teammateId);
    const normalizedBinding = normalizeBinding(binding, "binding");
    assertExpectedRevision(expectedRevision);
    const canonicalWorkspace = await canonicalizeTeammateWorkspace(workspace);
    const document = await this.readDocument();
    const actualRevision = documentRevision(document);
    if (actualRevision !== expectedRevision) {
      throw new TeammateEnablementStoreError(
        "revision_conflict",
        `Teammate workspace bindings changed (expected revision ${expectedRevision}, current revision ${actualRevision}).`,
      );
    }
    document.workspaces[canonicalWorkspace] = {
      ...(document.workspaces[canonicalWorkspace] ?? {}),
      [teammateId]: normalizedBinding,
    };
    await atomicWriteDocument(this.filePath, document);
    return {
      canonicalWorkspace,
      bindings: cloneBindings(document.workspaces[canonicalWorkspace]),
      revision: documentRevision(document),
    };
  }

  private async pruneWithinMutation(teammateId: string): Promise<boolean> {
    assertValidTeammateId(teammateId);
    const document = await this.readDocument();
    let changed = false;
    for (const [workspace, bindings] of Object.entries(document.workspaces)) {
      if (Object.hasOwn(bindings, teammateId)) {
        const next = { ...bindings };
        delete next[teammateId];
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
  setBinding(
    workspace: string,
    teammateId: string,
    binding: TeammateWorkspaceBinding,
    expectedRevision: string,
  ): Promise<TeammateWorkspaceBindingsSnapshot>;
  prune(teammateId: string): Promise<boolean>;
};

export type TeammateWorkspaceBindingsSnapshot = {
  canonicalWorkspace: string;
  bindings: Record<string, TeammateWorkspaceBinding>;
  revision: string;
};

export type TeammateWorkspaceBindingSnapshot = {
  canonicalWorkspace: string;
  binding: TeammateWorkspaceBinding | undefined;
  revision: string;
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
  if (value.schemaVersion !== 1 && value.schemaVersion !== TEAMMATE_ENABLEMENT_SCHEMA_VERSION) {
    throw invalidSchema(
      filePath,
      `schemaVersion must be 1 or ${TEAMMATE_ENABLEMENT_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(value.workspaces)) {
    throw invalidSchema(filePath, "workspaces must be an object");
  }

  const workspaces: Record<string, Record<string, TeammateWorkspaceBinding>> = {};
  for (const [workspace, rawBindings] of Object.entries(value.workspaces)) {
    if (!workspace.trim() || !isAbsolute(workspace)) {
      throw invalidSchema(
        filePath,
        `workspace key ${JSON.stringify(workspace)} must be an absolute path`,
      );
    }
    const key = normalizeTeammateWorkspaceKey(workspace);
    const field = `workspaces[${JSON.stringify(workspace)}]`;
    const normalizedBindings =
      value.schemaVersion === 1
        ? Object.fromEntries(
            normalizeEnabledIds(rawBindings, field, filePath).map((id) => [
              id,
              inheritBinding(true),
            ]),
          )
        : normalizeBindings(rawBindings, field, filePath);
    workspaces[key] = mergeBindings(workspaces[key] ?? {}, normalizedBindings);
  }
  return {
    schemaVersion: TEAMMATE_ENABLEMENT_SCHEMA_VERSION,
    workspaces: Object.fromEntries(
      Object.entries(workspaces).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function normalizeBindings(
  value: unknown,
  field: string,
  filePath?: string,
): Record<string, TeammateWorkspaceBinding> {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object of teammate bindings`);
  }
  const bindings: Record<string, TeammateWorkspaceBinding> = {};
  for (const [teammateId, binding] of Object.entries(value)) {
    if (!isValidTeammateId(teammateId)) {
      throw schemaOrInputError(filePath, `${field} contains an invalid teammate ID`);
    }
    bindings[teammateId] = normalizeBinding(
      binding,
      `${field}[${JSON.stringify(teammateId)}]`,
      filePath,
    );
  }
  return sortBindings(bindings);
}

function normalizeBinding(
  value: unknown,
  field: string,
  filePath?: string,
): TeammateWorkspaceBinding {
  assertAllowedFields(value, ["enabled", "toolProfile", "contextPolicy"], field, filePath);
  if (typeof value.enabled !== "boolean") {
    throw schemaOrInputError(filePath, `${field}.enabled must be a boolean`);
  }
  return {
    enabled: value.enabled,
    toolProfile: normalizeToolProfile(value.toolProfile, `${field}.toolProfile`, filePath),
    contextPolicy: normalizeContextPolicy(
      value.contextPolicy,
      `${field}.contextPolicy`,
      filePath,
    ),
  };
}

function normalizeContextPolicy(
  value: unknown,
  field: string,
  filePath?: string,
): TeammateContextPolicy {
  if (value === undefined || value === "persistent") return "persistent";
  if (value === "fresh_per_delegation") return "fresh_per_delegation";
  throw schemaOrInputError(
    filePath,
    `${field} must be persistent or fresh_per_delegation`,
  );
}

function normalizeToolProfile(
  value: unknown,
  field: string,
  filePath?: string,
): TeammateWorkspaceBinding["toolProfile"] {
  if (!isRecord(value) || (value.mode !== "inherit" && value.mode !== "custom")) {
    throw schemaOrInputError(filePath, `${field}.mode must be inherit or custom`);
  }
  if (value.mode === "inherit") {
    assertExactFields(value, ["mode"], field, filePath);
    return { mode: "inherit" };
  }
  assertExactFields(value, ["mode", "tools", "constraints"], field, filePath);
  if (
    !Array.isArray(value.tools) ||
    !value.tools.every((tool) => typeof tool === "string" && tool.trim())
  ) {
    throw schemaOrInputError(filePath, `${field}.tools must be an array of non-empty strings`);
  }
  assertExactFields(value.constraints, ["allow", "deny"], `${field}.constraints`, filePath);
  if (!Array.isArray(value.constraints.allow) || !Array.isArray(value.constraints.deny)) {
    throw schemaOrInputError(
      filePath,
      `${field}.constraints allow and deny must be arrays`,
    );
  }
  return {
    mode: "custom",
    tools: [...new Set(value.tools.map((tool) => tool.trim()))].sort(),
    constraints: {
      allow: value.constraints.allow.map((selector, index) =>
        normalizeSelector(selector, `${field}.constraints.allow[${index}]`, filePath)),
      deny: value.constraints.deny.map((selector, index) =>
        normalizeSelector(selector, `${field}.constraints.deny[${index}]`, filePath)),
    },
  };
}

function normalizeSelector(
  value: unknown,
  field: string,
  filePath?: string,
): ToolCallSelector {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be a tool-call selector`);
  }
  const allowedFields = value.conditions === undefined
    ? ["version", "toolName"]
    : ["version", "toolName", "conditions"];
  assertExactFields(value, allowedFields, field, filePath);
  if (
    value.version !== 2 ||
    typeof value.toolName !== "string" ||
    !value.toolName.trim()
  ) {
    throw schemaOrInputError(
      filePath,
      `${field} must contain version 2 and a non-empty toolName`,
    );
  }
  if (value.conditions === undefined) {
    return { version: 2, toolName: value.toolName.trim() };
  }
  if (!Array.isArray(value.conditions)) {
    throw schemaOrInputError(filePath, `${field}.conditions must be an array`);
  }
  const toolName = value.toolName.trim();
  const conditions = value.conditions.map((condition, index) =>
    normalizeCondition(condition, `${field}.conditions[${index}]`, filePath));
  if (conditions.some((condition) => !condition.subject.startsWith(`${toolName}.`))) {
    throw schemaOrInputError(
      filePath,
      `${field}.conditions contain a subject that does not belong to ${toolName}`,
    );
  }
  return {
    version: 2,
    toolName,
    conditions,
  };
}

function normalizeCondition(
  value: unknown,
  field: string,
  filePath?: string,
): ToolCallCondition {
  assertExactFields(value, ["subject", "operator", "value"], field, filePath);
  if (
    value.subject === "bash.command" &&
    value.operator === "executableEquals" &&
    typeof value.value === "string" &&
    value.value.trim()
  ) {
    return {
      subject: value.subject,
      operator: value.operator,
      value: value.value.trim(),
    };
  }
  if (
    value.subject === "bash.command" &&
    value.operator === "argvPrefix" &&
    Array.isArray(value.value) &&
    value.value.length > 0 &&
    value.value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return {
      subject: value.subject,
      operator: value.operator,
      value: [...value.value],
    };
  }
  if (
    isPathSubject(value.subject) &&
    (value.operator === "pathEquals" || value.operator === "pathWithin") &&
    typeof value.value === "string" &&
    value.value.trim()
  ) {
    return {
      subject: value.subject,
      operator: value.operator,
      value: value.value.trim(),
    };
  }
  throw schemaOrInputError(filePath, `${field} is not a supported selector condition`);
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

function inheritBinding(enabled: boolean): TeammateWorkspaceBinding {
  return { enabled, toolProfile: { mode: "inherit" }, contextPolicy: "persistent" };
}

function mergeBindings(
  left: Record<string, TeammateWorkspaceBinding>,
  right: Record<string, TeammateWorkspaceBinding>,
): Record<string, TeammateWorkspaceBinding> {
  return sortBindings({ ...left, ...right });
}

function sortBindings(
  bindings: Record<string, TeammateWorkspaceBinding>,
): Record<string, TeammateWorkspaceBinding> {
  return Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function cloneBindings(
  bindings: Record<string, TeammateWorkspaceBinding>,
): Record<string, TeammateWorkspaceBinding> {
  return structuredClone(sortBindings(bindings));
}

function documentRevision(document: TeammateEnablementDocument): string {
  const canonical = {
    schemaVersion: document.schemaVersion,
    workspaces: Object.fromEntries(
      Object.entries(document.workspaces)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([workspace, bindings]) => [workspace, sortBindings(bindings)]),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertExpectedRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TeammateEnablementStoreError(
      "invalid_input",
      "expectedRevision must be a SHA-256 revision returned by getBindings.",
    );
  }
}

function assertExactFields(
  value: unknown,
  allowedFields: readonly string[],
  field: string,
  filePath?: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  const actualFields = Object.keys(value).sort();
  const expectedFields = [...allowedFields].sort();
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((item, index) => item !== expectedFields[index])
  ) {
    throw schemaOrInputError(
      filePath,
      `${field} must contain only ${expectedFields.join(", ")}`,
    );
  }
}

function assertAllowedFields(
  value: unknown,
  allowedFields: readonly string[],
  field: string,
  filePath?: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((entry) => !allowed.has(entry));
  if (unknown.length > 0) {
    throw schemaOrInputError(
      filePath,
      `${field} must contain only ${[...allowed].sort().join(", ")}`,
    );
  }
}

function schemaOrInputError(
  filePath: string | undefined,
  reason: string,
): TeammateEnablementStoreError {
  return filePath
    ? invalidSchema(filePath, reason)
    : new TeammateEnablementStoreError("invalid_input", `${reason}.`);
}

function isPathSubject(value: unknown): value is Extract<
  ToolCallCondition,
  { operator: "pathEquals" | "pathWithin" }
>["subject"] {
  return typeof value === "string" && [
    "read_file.file_path",
    "read_file.target_path",
    "send_attachment.file_path",
    "send_attachment.target_path",
    "write_file.file_path",
    "write_file.target_path",
    "edit_file.file_path",
    "edit_file.target_path",
    "edit_notebook.notebook_path",
    "edit_notebook.target_path",
    "glob.search_root",
    "grep.path",
    "grep.search_root",
  ].includes(value);
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
