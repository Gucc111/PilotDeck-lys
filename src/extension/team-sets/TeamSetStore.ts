import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
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
  TEAM_SET_WORKSPACE_ASSIGNMENTS_FILE_NAME,
  getPilotTeamSetsDir,
  getPilotTeamSetWorkspaceAssignmentsFilePath,
} from "../../pilot/paths.js";
import {
  GlobalTeammateMutationLock,
} from "../teammates/GlobalTeammateMutationLock.js";
import { isValidTeammateId } from "../teammates/teammateId.js";
import { canonicalizeWorkspace } from "../teammates/workspaceKey.js";
import type {
  ToolCallCondition,
  ToolCallSelector,
} from "../../permission/index.js";
import type { TeammateContextPolicy } from "../teammates/types.js";
import {
  TEAM_SET_SCHEMA_VERSION,
  TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION,
  type TeamSetDefinition,
  type TeamSetLeaderConfig,
  type TeamSetLeaderToolProfile,
  type TeamSetStoreErrorCode,
  type TeamSetStoreOptions,
  type TeamSetSummary,
  type TeamSetTeammateConfig,
  type TeamSetTeammateToolProfile,
  type TeamSetWorkspaceAssignmentDocument,
} from "./types.js";

const TEAM_SET_ID_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

function isValidTeamSetId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    TEAM_SET_ID_RE.test(id) &&
    !id.includes("..")
  );
}

export class TeamSetStore {
  readonly pilotHome: string;
  readonly teamSetsDir: string;
  readonly assignmentsFilePath: string;
  readonly mutationLock: GlobalTeammateMutationLock;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: TeamSetStoreOptions) {
    if (!options || typeof options.pilotHome !== "string" || !options.pilotHome.trim()) {
      throw new TeamSetStoreError("invalid_input", "pilotHome is required.");
    }
    this.pilotHome = resolve(options.pilotHome);
    this.teamSetsDir = getPilotTeamSetsDir(this.pilotHome);
    this.assignmentsFilePath = getPilotTeamSetWorkspaceAssignmentsFilePath(this.pilotHome);
    this.mutationLock = new GlobalTeammateMutationLock(
      resolve(this.teamSetsDir, ".team-set-mutation.lock"),
    );
  }

  async list(): Promise<TeamSetSummary[]> {
    await assertSafeStoragePath(this.pilotHome, this.teamSetsDir);
    let entries: string[];
    try {
      entries = await readdir(this.teamSetsDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const summaries: TeamSetSummary[] = [];
    for (const entry of entries) {
      if (
        !entry.endsWith(".json") ||
        entry.startsWith(".") ||
        entry === TEAM_SET_WORKSPACE_ASSIGNMENTS_FILE_NAME
      ) {
        continue;
      }
      const id = entry.slice(0, -5);
      try {
        const teamSet = await this.readTeamSetFile(id);
        summaries.push({
          id: teamSet.id,
          name: teamSet.name,
          description: teamSet.description,
          teammateCount: Object.keys(teamSet.teammates).length,
          leaderMode: teamSet.leader.mode,
        });
      } catch {
        // skip malformed files
      }
    }
    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<{ teamSet: TeamSetDefinition; revision: string }> {
    assertValidTeamSetId(id);
    const teamSet = await this.readTeamSetFile(id);
    return { teamSet, revision: teamSetRevision(teamSet) };
  }

  async create(
    teamSet: Omit<TeamSetDefinition, "schemaVersion">,
  ): Promise<{ teamSet: TeamSetDefinition; revision: string }> {
    const normalized = normalizeTeamSetInput(teamSet);
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const filePath = this.teamSetFilePath(normalized.id);
        await assertSafeStoragePath(this.pilotHome, filePath);
        if (await fileExists(filePath)) {
          throw new TeamSetStoreError(
            "duplicate_id",
            `A team set with ID "${normalized.id}" already exists.`,
          );
        }
        await atomicWriteTeamSet(filePath, normalized);
        return { teamSet: normalized, revision: teamSetRevision(normalized) };
      }),
    );
  }

  async write(
    id: string,
    teamSet: Omit<TeamSetDefinition, "schemaVersion">,
    expectedRevision: string,
  ): Promise<{ teamSet: TeamSetDefinition; revision: string }> {
    assertValidTeamSetId(id);
    assertExpectedRevision(expectedRevision);
    const normalized = normalizeTeamSetInput({ ...teamSet, id });
    if (normalized.id !== id) {
      throw new TeamSetStoreError(
        "invalid_input",
        "Team set ID in the body must match the path ID.",
      );
    }
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const current = await this.readTeamSetFile(id);
        const currentRevision = teamSetRevision(current);
        if (currentRevision !== expectedRevision) {
          throw new TeamSetStoreError(
            "revision_conflict",
            `Team set "${id}" changed (expected revision ${expectedRevision}, current ${currentRevision}).`,
          );
        }
        const filePath = this.teamSetFilePath(id);
        await atomicWriteTeamSet(filePath, normalized);
        return { teamSet: normalized, revision: teamSetRevision(normalized) };
      }),
    );
  }

  async delete(id: string): Promise<{ ok: true; id: string }> {
    assertValidTeamSetId(id);
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const filePath = this.teamSetFilePath(id);
        await assertSafeStoragePath(this.pilotHome, filePath);
        try {
          await rm(filePath);
        } catch (error) {
          if (isErrno(error, "ENOENT")) {
            throw new TeamSetStoreError("not_found", `Team set "${id}" not found.`);
          }
          throw error;
        }
        await this.removeAssignmentsForTeamSet(id);
        return { ok: true as const, id };
      }),
    );
  }

  async getAssignment(
    workspace: string,
  ): Promise<{ canonicalProjectKey: string; teamSetId: string | null; revision: string }> {
    const canonicalProjectKey = await canonicalizeWorkspace(workspace);
    const document = await this.readAssignmentsDocument();
    return {
      canonicalProjectKey,
      teamSetId: document.workspaces[canonicalProjectKey] ?? null,
      revision: assignmentsRevision(document),
    };
  }

  async setAssignment(
    workspace: string,
    teamSetId: string | null,
    expectedRevision: string,
  ): Promise<{ canonicalProjectKey: string; teamSetId: string | null; revision: string }> {
    assertExpectedRevision(expectedRevision);
    if (teamSetId !== null) {
      assertValidTeamSetId(teamSetId);
    }
    return this.enqueueWrite(() =>
      this.mutationLock.runExclusive(async () => {
        const canonicalProjectKey = await canonicalizeWorkspace(workspace);
        const document = await this.readAssignmentsDocument();
        const currentRevision = assignmentsRevision(document);
        if (currentRevision !== expectedRevision) {
          throw new TeamSetStoreError(
            "revision_conflict",
            `Workspace assignments changed (expected revision ${expectedRevision}, current ${currentRevision}).`,
          );
        }
        if (teamSetId !== null) {
          if (!(await fileExists(this.teamSetFilePath(teamSetId)))) {
            throw new TeamSetStoreError(
              "not_found",
              `Team set "${teamSetId}" not found.`,
            );
          }
          document.workspaces[canonicalProjectKey] = teamSetId;
        } else {
          delete document.workspaces[canonicalProjectKey];
        }
        await atomicWriteAssignments(this.assignmentsFilePath, document);
        return {
          canonicalProjectKey,
          teamSetId: document.workspaces[canonicalProjectKey] ?? null,
          revision: assignmentsRevision(document),
        };
      }),
    );
  }

  private teamSetFilePath(id: string): string {
    return resolve(this.teamSetsDir, `${id}.json`);
  }

  private async readTeamSetFile(id: string): Promise<TeamSetDefinition> {
    assertValidTeamSetId(id);
    const filePath = this.teamSetFilePath(id);
    await assertSafeStoragePath(this.pilotHome, filePath);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new TeamSetStoreError("not_found", `Team set "${id}" not found.`);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new TeamSetStoreError(
        "invalid_json",
        `Unable to parse team set JSON at ${filePath}: ${errorMessage(error)}`,
      );
    }
    return normalizeTeamSetDocument(parsed, filePath);
  }

  private async readAssignmentsDocument(): Promise<TeamSetWorkspaceAssignmentDocument> {
    await assertSafeStoragePath(this.pilotHome, this.assignmentsFilePath);
    let content: string;
    try {
      content = await readFile(this.assignmentsFilePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyAssignmentsDocument();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new TeamSetStoreError(
        "invalid_json",
        `Unable to parse workspace assignments JSON at ${this.assignmentsFilePath}: ${errorMessage(error)}`,
      );
    }
    return normalizeAssignmentsDocument(parsed, this.assignmentsFilePath);
  }

  private async removeAssignmentsForTeamSet(teamSetId: string): Promise<void> {
    const document = await this.readAssignmentsDocument();
    let changed = false;
    for (const [workspace, assignedId] of Object.entries(document.workspaces)) {
      if (assignedId === teamSetId) {
        delete document.workspaces[workspace];
        changed = true;
      }
    }
    if (changed) {
      await atomicWriteAssignments(this.assignmentsFilePath, document);
    }
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

export class TeamSetStoreError extends Error {
  constructor(
    public readonly code: TeamSetStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamSetStoreError";
  }
}

// ---------------------------------------------------------------------------
// Revision helpers
// ---------------------------------------------------------------------------

function teamSetRevision(teamSet: TeamSetDefinition): string {
  return createHash("sha256").update(JSON.stringify(teamSet)).digest("hex");
}

function assignmentsRevision(document: TeamSetWorkspaceAssignmentDocument): string {
  const canonical = {
    schemaVersion: document.schemaVersion,
    workspaces: Object.fromEntries(
      Object.entries(document.workspaces)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function emptyAssignmentsDocument(): TeamSetWorkspaceAssignmentDocument {
  return {
    schemaVersion: TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION,
    workspaces: {},
  };
}

// ---------------------------------------------------------------------------
// Document normalization (on-disk JSON → validated types)
// ---------------------------------------------------------------------------

function normalizeTeamSetDocument(
  value: unknown,
  filePath: string,
): TeamSetDefinition {
  if (!isRecord(value)) {
    throw invalidSchema(filePath, "root must be an object");
  }
  if (value.schemaVersion !== TEAM_SET_SCHEMA_VERSION) {
    throw invalidSchema(
      filePath,
      `schemaVersion must be ${TEAM_SET_SCHEMA_VERSION}`,
    );
  }
  return normalizeTeamSetFields(value, filePath);
}

function normalizeAssignmentsDocument(
  value: unknown,
  filePath: string,
): TeamSetWorkspaceAssignmentDocument {
  if (!isRecord(value)) {
    throw invalidSchema(filePath, "root must be an object");
  }
  if (value.schemaVersion !== TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION) {
    throw invalidSchema(
      filePath,
      `schemaVersion must be ${TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(value.workspaces)) {
    throw invalidSchema(filePath, "workspaces must be an object");
  }
  const workspaces: Record<string, string> = {};
  for (const [workspace, teamSetId] of Object.entries(value.workspaces)) {
    if (!workspace.trim() || !isAbsolute(workspace)) {
      throw invalidSchema(
        filePath,
        `workspace key ${JSON.stringify(workspace)} must be an absolute path`,
      );
    }
    if (typeof teamSetId !== "string" || !isValidTeamSetId(teamSetId)) {
      throw invalidSchema(
        filePath,
        `workspace ${JSON.stringify(workspace)} has an invalid team set ID`,
      );
    }
    workspaces[workspace] = teamSetId;
  }
  return {
    schemaVersion: TEAM_SET_WORKSPACE_ASSIGNMENT_SCHEMA_VERSION,
    workspaces: Object.fromEntries(
      Object.entries(workspaces).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Input normalization (API/UI input → validated types)
// ---------------------------------------------------------------------------

function normalizeTeamSetInput(
  value: unknown,
): TeamSetDefinition {
  return normalizeTeamSetFields(value);
}

function normalizeTeamSetFields(
  value: unknown,
  filePath?: string,
): TeamSetDefinition {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, "team set must be an object");
  }
  const allowed = ["schemaVersion", "id", "name", "description", "leader", "teammates"];
  assertAllowedFields(value, allowed, "teamSet", filePath);
  if (!isValidTeamSetId(value.id)) {
    throw schemaOrInputError(filePath, "team set ID is invalid");
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw schemaOrInputError(filePath, "team set name must be a non-empty string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw schemaOrInputError(filePath, "team set description must be a string");
  }
  const leader = normalizeLeaderConfig(value.leader, "leader", filePath);
  const teammates = normalizeTeammatesMap(value.teammates, "teammates", filePath);
  const definition: TeamSetDefinition = {
    schemaVersion: TEAM_SET_SCHEMA_VERSION,
    id: value.id,
    name: value.name.trim(),
    leader,
    teammates,
  };
  if (typeof value.description === "string" && value.description.trim()) {
    definition.description = value.description.trim();
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Leader config normalization
// ---------------------------------------------------------------------------

function normalizeLeaderConfig(
  value: unknown,
  field: string,
  filePath?: string,
): TeamSetLeaderConfig {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  if (value.mode === "inherit") {
    assertExactFields(value, ["mode"], field, filePath);
    return { mode: "inherit" };
  }
  if (value.mode === "override") {
    const allowed = [
      "mode", "model", "maxContextTokens", "maxOutputTokens",
      "toolProfile", "prompt", "plugins", "skills", "mcpServers",
    ];
    assertAllowedFields(value, allowed, field, filePath);
    const result: Extract<TeamSetLeaderConfig, { mode: "override" }> = { mode: "override" };
    if (value.model !== undefined) {
      assertString(value.model, `${field}.model`, filePath);
      result.model = value.model;
    }
    if (value.maxContextTokens !== undefined) {
      assertPositiveInteger(value.maxContextTokens, `${field}.maxContextTokens`, filePath);
      result.maxContextTokens = value.maxContextTokens;
    }
    if (value.maxOutputTokens !== undefined) {
      assertPositiveInteger(value.maxOutputTokens, `${field}.maxOutputTokens`, filePath);
      result.maxOutputTokens = value.maxOutputTokens;
    }
    if (value.toolProfile !== undefined) {
      result.toolProfile = normalizeLeaderToolProfile(
        value.toolProfile, `${field}.toolProfile`, filePath,
      );
    }
    if (value.prompt !== undefined) {
      assertString(value.prompt, `${field}.prompt`, filePath);
      result.prompt = value.prompt;
    }
    if (value.plugins !== undefined) {
      result.plugins = normalizeStringArray(value.plugins, `${field}.plugins`, filePath);
    }
    if (value.skills !== undefined) {
      result.skills = normalizeStringArray(value.skills, `${field}.skills`, filePath);
    }
    if (value.mcpServers !== undefined) {
      result.mcpServers = normalizeStringArray(value.mcpServers, `${field}.mcpServers`, filePath);
    }
    return result;
  }
  if (value.mode === "standalone") {
    const required = ["mode", "tools", "plugins", "skills", "mcpServers", "prompt"] as const;
    const allowed = [...required, "model", "maxContextTokens", "maxOutputTokens"];
    assertAllowedFields(value, allowed, field, filePath);
    for (const key of required) {
      if (key === "mode") continue;
      if (value[key] === undefined) {
        throw schemaOrInputError(filePath, `${field}.${key} is required for standalone mode`);
      }
    }
    assertString(value.prompt, `${field}.prompt`, filePath);
    const result: Extract<TeamSetLeaderConfig, { mode: "standalone" }> = {
      mode: "standalone",
      tools: normalizeStringArray(value.tools, `${field}.tools`, filePath),
      plugins: normalizeStringArray(value.plugins, `${field}.plugins`, filePath),
      skills: normalizeStringArray(value.skills, `${field}.skills`, filePath),
      mcpServers: normalizeStringArray(value.mcpServers, `${field}.mcpServers`, filePath),
      prompt: value.prompt,
    };
    if (value.model !== undefined) {
      assertString(value.model, `${field}.model`, filePath);
      result.model = value.model;
    }
    if (value.maxContextTokens !== undefined) {
      assertPositiveInteger(value.maxContextTokens, `${field}.maxContextTokens`, filePath);
      result.maxContextTokens = value.maxContextTokens;
    }
    if (value.maxOutputTokens !== undefined) {
      assertPositiveInteger(value.maxOutputTokens, `${field}.maxOutputTokens`, filePath);
      result.maxOutputTokens = value.maxOutputTokens;
    }
    return result;
  }
  throw schemaOrInputError(filePath, `${field}.mode must be inherit, override, or standalone`);
}

function normalizeLeaderToolProfile(
  value: unknown,
  field: string,
  filePath?: string,
): TeamSetLeaderToolProfile {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  if (value.mode === "inherit") {
    assertExactFields(value, ["mode"], field, filePath);
    return { mode: "inherit" };
  }
  if (value.mode === "custom") {
    assertExactFields(value, ["mode", "tools"], field, filePath);
    return {
      mode: "custom",
      tools: normalizeStringArray(value.tools, `${field}.tools`, filePath),
    };
  }
  throw schemaOrInputError(filePath, `${field}.mode must be inherit or custom`);
}

// ---------------------------------------------------------------------------
// Teammate config normalization
// ---------------------------------------------------------------------------

function normalizeTeammatesMap(
  value: unknown,
  field: string,
  filePath?: string,
): Record<string, TeamSetTeammateConfig> {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  const result: Record<string, TeamSetTeammateConfig> = {};
  for (const [id, config] of Object.entries(value)) {
    if (!isValidTeammateId(id)) {
      throw schemaOrInputError(filePath, `${field} contains an invalid teammate ID`);
    }
    result[id] = normalizeTeammateConfig(
      config, `${field}[${JSON.stringify(id)}]`, filePath,
    );
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeTeammateConfig(
  value: unknown,
  field: string,
  filePath?: string,
): TeamSetTeammateConfig {
  const allowed = [
    "toolProfile", "contextPolicy", "modelOverride", "promptOverride",
    "maxContextTokensOverride", "maxOutputTokensOverride",
  ];
  assertAllowedFields(value, allowed, field, filePath);
  if (value.toolProfile === undefined) {
    throw schemaOrInputError(filePath, `${field}.toolProfile is required`);
  }
  const result: TeamSetTeammateConfig = {
    toolProfile: normalizeTeammateToolProfile(
      value.toolProfile, `${field}.toolProfile`, filePath,
    ),
  };
  if (value.contextPolicy !== undefined) {
    result.contextPolicy = normalizeContextPolicy(
      value.contextPolicy, `${field}.contextPolicy`, filePath,
    );
  }
  if (value.modelOverride !== undefined) {
    assertString(value.modelOverride, `${field}.modelOverride`, filePath);
    result.modelOverride = value.modelOverride;
  }
  if (value.promptOverride !== undefined) {
    assertString(value.promptOverride, `${field}.promptOverride`, filePath);
    result.promptOverride = value.promptOverride;
  }
  if (value.maxContextTokensOverride !== undefined) {
    assertPositiveInteger(
      value.maxContextTokensOverride, `${field}.maxContextTokensOverride`, filePath,
    );
    result.maxContextTokensOverride = value.maxContextTokensOverride;
  }
  if (value.maxOutputTokensOverride !== undefined) {
    assertPositiveInteger(
      value.maxOutputTokensOverride, `${field}.maxOutputTokensOverride`, filePath,
    );
    result.maxOutputTokensOverride = value.maxOutputTokensOverride;
  }
  return result;
}

function normalizeTeammateToolProfile(
  value: unknown,
  field: string,
  filePath?: string,
): TeamSetTeammateToolProfile {
  if (!isRecord(value)) {
    throw schemaOrInputError(filePath, `${field} must be an object`);
  }
  if (value.mode === "inherit") {
    assertExactFields(value, ["mode"], field, filePath);
    return { mode: "inherit" };
  }
  if (value.mode === "custom") {
    assertExactFields(value, ["mode", "tools", "constraints"], field, filePath);
    if (
      !Array.isArray(value.tools) ||
      !value.tools.every((tool: unknown) => typeof tool === "string" && (tool as string).trim())
    ) {
      throw schemaOrInputError(
        filePath, `${field}.tools must be an array of non-empty strings`,
      );
    }
    assertExactFields(
      value.constraints, ["allow", "deny"], `${field}.constraints`, filePath,
    );
    if (
      !Array.isArray(value.constraints.allow) ||
      !Array.isArray(value.constraints.deny)
    ) {
      throw schemaOrInputError(
        filePath, `${field}.constraints allow and deny must be arrays`,
      );
    }
    return {
      mode: "custom",
      tools: [...new Set(value.tools.map((tool: string) => tool.trim()))].sort(),
      constraints: {
        allow: value.constraints.allow.map((selector: unknown, index: number) =>
          normalizeSelector(
            selector, `${field}.constraints.allow[${index}]`, filePath,
          )),
        deny: value.constraints.deny.map((selector: unknown, index: number) =>
          normalizeSelector(
            selector, `${field}.constraints.deny[${index}]`, filePath,
          )),
      },
    };
  }
  throw schemaOrInputError(filePath, `${field}.mode must be inherit or custom`);
}

function normalizeContextPolicy(
  value: unknown,
  field: string,
  filePath?: string,
): TeammateContextPolicy {
  if (value === "persistent") return "persistent";
  if (value === "fresh_per_delegation") return "fresh_per_delegation";
  throw schemaOrInputError(
    filePath,
    `${field} must be persistent or fresh_per_delegation`,
  );
}

// ---------------------------------------------------------------------------
// Tool constraint selector/condition normalization
// ---------------------------------------------------------------------------

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
  const conditions = value.conditions.map(
    (condition: unknown, index: number) =>
      normalizeCondition(condition, `${field}.conditions[${index}]`, filePath),
  );
  if (conditions.some((condition: ToolCallCondition) =>
    !condition.subject.startsWith(`${toolName}.`))) {
    throw schemaOrInputError(
      filePath,
      `${field}.conditions contain a subject that does not belong to ${toolName}`,
    );
  }
  return { version: 2, toolName, conditions };
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
    value.value.every((item: unknown) => typeof item === "string" && (item as string).length > 0)
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

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertValidTeamSetId(id: unknown): asserts id is string {
  if (!isValidTeamSetId(id)) {
    throw new TeamSetStoreError(
      "invalid_input",
      "id must be a valid team set ID.",
    );
  }
}

function assertExpectedRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TeamSetStoreError(
      "invalid_input",
      "expectedRevision must be a SHA-256 revision.",
    );
  }
}

function assertString(
  value: unknown,
  field: string,
  filePath?: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw schemaOrInputError(filePath, `${field} must be a string`);
  }
}

function assertPositiveInteger(
  value: unknown,
  field: string,
  filePath?: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw schemaOrInputError(filePath, `${field} must be a positive integer`);
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
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw schemaOrInputError(
      filePath,
      `${field} contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Atomic I/O
// ---------------------------------------------------------------------------

async function atomicWriteTeamSet(
  filePath: string,
  teamSet: TeamSetDefinition,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(
    directory,
    `.team-set.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(teamSet, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function atomicWriteAssignments(
  filePath: string,
  document: TeamSetWorkspaceAssignmentDocument,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolve(
    directory,
    `.${TEAM_SET_WORKSPACE_ASSIGNMENTS_FILE_NAME}.${randomUUID()}.tmp`,
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
    throw new TeamSetStoreError(
      "unsafe_path",
      "Team set path leaves PILOT_HOME.",
    );
  }
  let current = pilotHome;
  for (const part of fromHome.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new TeamSetStoreError(
          "unsafe_path",
          `Refusing to access team set through symlink: ${relative(pilotHome, current)}.`,
        );
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeStringArray(
  value: unknown,
  field: string,
  filePath?: string,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => typeof item === "string")
  ) {
    throw schemaOrInputError(filePath, `${field} must be an array of strings`);
  }
  return [...value];
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

function schemaOrInputError(
  filePath: string | undefined,
  reason: string,
): TeamSetStoreError {
  return filePath
    ? invalidSchema(filePath, reason)
    : new TeamSetStoreError("invalid_input", `${reason}.`);
}

function invalidSchema(
  filePath: string,
  reason: string,
): TeamSetStoreError {
  return new TeamSetStoreError(
    "invalid_schema",
    `Invalid team set schema at ${filePath}: ${reason}.`,
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
