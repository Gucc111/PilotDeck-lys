/** Atomically remove the latest user turn from a normal web-session transcript. */

import { randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { mergeMetadata } from "../../session/metadata/SessionMetadataStore.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "../../session/transcript/TranscriptEntry.js";
import type {
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../client/protocol.js";

export type ReplaceLastWebSessionTurnOptions = {
  projectRoot: string;
  pilotHome: string;
  now?: () => Date;
};

type ReplacementJournal = {
  version: 1;
  transactionId: string;
  sessionKey: string;
  replacementTurnId: string;
  preparedAt: string;
};

export type RecoverLastTurnReplacementsResult = {
  committed: number;
  rolledBack: number;
  cleaned: number;
  failures: Array<{ transcriptPath: string; message: string }>;
};

export class ReplaceLastTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReplaceLastTurnError";
  }
}

function findLatestAcceptedInput(
  entries: Awaited<ReturnType<typeof readTranscript>>["entries"],
): { entry: AgentAcceptedInputTranscriptEntry; index: number } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "accepted_input") return { entry, index };
  }
  return undefined;
}

function replacementPaths(
  sessionKey: string,
  projectKey: string,
  pilotHome: string,
  transactionId?: string,
): { transcriptPath: string; safeId: string; backupPath?: string; journalPath?: string } {
  const chatDir = getPilotProjectChatDir(projectKey, pilotHome);
  const safeId = sanitizeSessionIdForPath(sessionKey);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  return {
    transcriptPath,
    safeId,
    ...(transactionId
      ? {
          backupPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.bak`),
          journalPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.json`),
        }
      : {}),
  };
}

function latestMetadataSnapshot(entries: AgentTranscriptEntry[]): SessionMetadataValue {
  return entries.reduce<SessionMetadataValue>((metadata, entry) => (
    entry.type === "session_metadata"
      ? mergeMetadata(metadata, entry.metadata)
      : metadata
  ), {});
}

function removeGeneratedTitleFromPrefix(entries: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "session_metadata" || entry.metadata.aiTitle === undefined) return entry;
    const metadata = { ...entry.metadata };
    delete metadata.aiTitle;
    return { ...entry, metadata };
  });
}

function createPreservedMetadataEntry(
  entries: AgentTranscriptEntry[],
  preserved: AgentTranscriptEntry[],
  now: Date,
): AgentSessionMetadataTranscriptEntry | undefined {
  const metadata = latestMetadataSnapshot(entries);
  delete metadata.lastPrompt;
  if (!preserved.some((entry) => entry.type === "accepted_input")) {
    delete metadata.firstPrompt;
    // The generated title describes the original first prompt. A corrected
    // first prompt must be allowed to generate a fresh aiTitle, while a title
    // explicitly chosen by the user remains intact.
    delete metadata.aiTitle;
  }

  const hasMetadata = Object.entries(metadata).some(([key, value]) => (
    key !== "isSnapshot" && key !== "updatedAt" && value !== undefined
  ));
  if (!hasMetadata) return undefined;

  const sequence = preserved.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 1;
  const parentEntryId = [...preserved]
    .reverse()
    .find((entry) => typeof entry.entryId === "string" && entry.entryId)?.entryId ?? null;
  return {
    type: "session_metadata",
    sessionId: entries[0]?.sessionId ?? "",
    turnId: "metadata-replace",
    sequence,
    createdAt: now.toISOString(),
    entryId: randomUUID(),
    parentEntryId,
    metadata: {
      ...metadata,
      isSnapshot: true,
      updatedAt: now.toISOString(),
    },
  };
}

function validateTransactionId(transactionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) {
    throw new ReplaceLastTurnError("replace_invalid_transaction", "The replacement transaction is invalid.");
  }
}

function isTransactionId(transactionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId);
}

function readReplacementJournalSync(
  journalPath: string,
  transactionId: string,
): ReplacementJournal | undefined {
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<ReplacementJournal>;
    if (
      parsed.version !== 1
      || parsed.transactionId !== transactionId
      || typeof parsed.sessionKey !== "string"
      || !parsed.sessionKey.trim()
      || typeof parsed.replacementTurnId !== "string"
      || !parsed.replacementTurnId.trim()
      || typeof parsed.preparedAt !== "string"
    ) {
      return undefined;
    }
    return parsed as ReplacementJournal;
  } catch {
    return undefined;
  }
}

function acceptedTurnIds(body: string): Set<string> {
  const turnIds = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"') || !line.includes('"turnId"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; turnId?: unknown };
      if (entry.type === "accepted_input" && typeof entry.turnId === "string") {
        turnIds.add(entry.turnId);
      }
    } catch {
      // Malformed lines do not provide durable commit evidence.
    }
  }
  return turnIds;
}

function readAcceptedTurnIdsSync(transcriptPath: string): Set<string> {
  try {
    return acceptedTurnIds(readFileSync(transcriptPath, "utf8"));
  } catch {
    // A missing transcript is restored from the newest available backup.
    return new Set();
  }
}

type ReplacementArtifact = {
  safeId: string;
  transactionId: string;
  backupPath: string;
  journalPath: string;
};

/**
 * Recover replacement transactions left behind by a process crash.
 *
 * A durable accepted_input for the replacement turn means the transaction
 * committed and only stale artifacts need cleanup. Otherwise the newest
 * backup is restored atomically. This runs before a local Gateway starts, so
 * no transcript writer can race the recovery pass.
 */
export function recoverPendingLastTurnReplacements(
  pilotHome: string,
): RecoverLastTurnReplacementsResult {
  const result: RecoverLastTurnReplacementsResult = {
    committed: 0,
    rolledBack: 0,
    cleaned: 0,
    failures: [],
  };
  const groups = new Map<string, { transcriptPath: string; artifacts: ReplacementArtifact[] }>();
  const projectsDir = resolve(pilotHome, "projects");
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsDir, { withFileTypes: true, encoding: "utf8" })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }

  for (const projectDirName of projectDirNames) {
    const chatDir = resolve(projectsDir, projectDirName, "chats");
    let names: string[];
    try {
      names = readdirSync(chatDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^\.(.+)\.([0-9a-f-]{36})\.replace\.(?:bak|json)$/i.exec(name);
      if (!match || !isTransactionId(match[2])) continue;
      const [, safeId, transactionId] = match;
      const key = resolve(chatDir, safeId);
      const group = groups.get(key) ?? {
        transcriptPath: resolve(chatDir, `${safeId}.jsonl`),
        artifacts: [],
      };
      if (!group.artifacts.some((artifact) => artifact.transactionId === transactionId)) {
        group.artifacts.push({
          safeId,
          transactionId,
          backupPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.bak`),
          journalPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.json`),
        });
      }
      groups.set(key, group);
    }
  }

  for (const group of groups.values()) {
    try {
      const currentAcceptedTurnIds = readAcceptedTurnIdsSync(group.transcriptPath);
      const committed = group.artifacts.some((artifact) => {
        const journal = readReplacementJournalSync(artifact.journalPath, artifact.transactionId);
        if (journal) return currentAcceptedTurnIds.has(journal.replacementTurnId);

        // Backups created by the first transactional release did not have a
        // journal. If the current transcript contains a turn absent from the
        // backup, input acceptance already advanced the session and restoring
        // the legacy backup would undo a committed edit.
        try {
          const originalTurnIds = acceptedTurnIds(readFileSync(artifact.backupPath, "utf8"));
          return [...currentAcceptedTurnIds].some((turnId) => !originalTurnIds.has(turnId));
        } catch {
          return false;
        }
      });
      if (committed) {
        for (const artifact of group.artifacts) {
          rmSync(artifact.backupPath, { force: true });
          rmSync(artifact.journalPath, { force: true });
        }
        result.committed += 1;
        result.cleaned += group.artifacts.length;
        continue;
      }

      const restorable = group.artifacts
        .map((artifact) => {
          try {
            return { artifact, mtimeMs: statSync(artifact.backupPath).mtimeMs };
          } catch {
            return undefined;
          }
        })
        .filter((candidate): candidate is { artifact: ReplacementArtifact; mtimeMs: number } => Boolean(candidate))
        .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
      if (!restorable) {
        for (const artifact of group.artifacts) {
          rmSync(artifact.journalPath, { force: true });
        }
        result.cleaned += group.artifacts.length;
        continue;
      }

      const originalBody = readFileSync(restorable.artifact.backupPath, "utf8");
      const temporaryPath = resolve(
        dirname(group.transcriptPath),
        `.${restorable.artifact.safeId}.${randomUUID()}.recovery.tmp`,
      );
      try {
        writeFileSync(temporaryPath, originalBody, { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, group.transcriptPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      for (const artifact of group.artifacts) {
        rmSync(artifact.backupPath, { force: true });
        rmSync(artifact.journalPath, { force: true });
      }
      result.rolledBack += 1;
      result.cleaned += group.artifacts.length;
    } catch (error) {
      result.failures.push({
        transcriptPath: group.transcriptPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function replaceLastWebSessionTurn(
  input: WebReplaceLastTurnInput,
  options: ReplaceLastWebSessionTurnOptions,
): Promise<WebReplaceLastTurnResult> {
  if (
    typeof input.sessionKey !== "string"
    || !input.sessionKey.trim()
    || typeof input.expectedTurnId !== "string"
    || !input.expectedTurnId.trim()
    || typeof input.replacementTurnId !== "string"
    || !input.replacementTurnId.trim()
  ) {
    throw new ReplaceLastTurnError(
      "replace_invalid_input",
      "sessionKey, expectedTurnId, and replacementTurnId are required.",
    );
  }

  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const { transcriptPath, safeId } = replacementPaths(
    input.sessionKey,
    effectiveProjectRoot,
    options.pilotHome,
  );
  const { entries, diagnostics } = await readTranscript(transcriptPath);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ReplaceLastTurnError(
      "replace_invalid_transcript",
      "The conversation transcript could not be safely rewritten.",
    );
  }

  const latest = findLatestAcceptedInput(entries);
  if (!latest) {
    throw new ReplaceLastTurnError("replace_empty_transcript", "No user turn is available to replace.");
  }
  const { entry: latestInput, index: latestInputIndex } = latest;
  if (latestInput.turnId !== input.expectedTurnId) {
    throw new ReplaceLastTurnError(
      "replace_turn_conflict",
      "The selected message is no longer the latest user turn.",
    );
  }

  const originalPrefix = entries.slice(0, latestInputIndex);
  const replacingFirstInput = !originalPrefix.some((entry) => entry.type === "accepted_input");
  const preserved = replacingFirstInput
    ? removeGeneratedTitleFromPrefix(originalPrefix)
    : originalPrefix;
  const metadataEntry = createPreservedMetadataEntry(
    entries,
    preserved,
    options.now?.() ?? new Date(),
  );
  const rewrittenEntries = metadataEntry ? [...preserved, metadataEntry] : preserved;
  const body = rewrittenEntries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const originalBody = await readFile(transcriptPath, "utf8");
  const transactionId = randomUUID();
  const { backupPath, journalPath } = replacementPaths(
    input.sessionKey,
    effectiveProjectRoot,
    options.pilotHome,
    transactionId,
  );
  if (!backupPath || !journalPath) throw new Error("Replacement transaction paths were not created.");
  const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.replace.tmp`);
  try {
    await writeFile(backupPath, originalBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const journal: ReplacementJournal = {
      version: 1,
      transactionId,
      sessionKey: input.sessionKey,
      replacementTurnId: input.replacementTurnId,
      preparedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, transcriptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(backupPath, { force: true }).catch(() => undefined);
    await rm(journalPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    sessionKey: input.sessionKey,
    replacedTurnId: latestInput.turnId,
    removedEntryCount: entries.length - latestInputIndex,
    transactionId,
  };
}

export async function finalizeLastWebSessionTurnReplacement(
  input: WebFinalizeLastTurnReplacementInput,
  options: ReplaceLastWebSessionTurnOptions,
): Promise<WebFinalizeLastTurnReplacementResult> {
  if (
    typeof input.sessionKey !== "string"
    || !input.sessionKey.trim()
    || typeof input.transactionId !== "string"
    || !input.transactionId.trim()
  ) {
    throw new ReplaceLastTurnError(
      "replace_invalid_transaction",
      "sessionKey and transactionId are required.",
    );
  }
  validateTransactionId(input.transactionId);
  if (input.action !== "commit" && input.action !== "rollback") {
    throw new ReplaceLastTurnError("replace_invalid_action", "Replacement action must be commit or rollback.");
  }

  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const { transcriptPath, safeId, backupPath, journalPath } = replacementPaths(
    input.sessionKey,
    effectiveProjectRoot,
    options.pilotHome,
    input.transactionId,
  );
  if (!backupPath || !journalPath) throw new Error("Replacement transaction paths were not created.");

  if (input.action === "commit") {
    await rm(backupPath, { force: true });
    await rm(journalPath, { force: true });
  } else {
    let originalBody: string;
    try {
      originalBody = await readFile(backupPath, "utf8");
    } catch (error) {
      throw new ReplaceLastTurnError(
        "replace_transaction_missing",
        `The replacement transaction could not be restored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.rollback.tmp`);
    try {
      await writeFile(temporaryPath, originalBody, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, transcriptPath);
      await rm(backupPath, { force: true });
      await rm(journalPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    sessionKey: input.sessionKey,
    transactionId: input.transactionId,
    action: input.action,
  };
}
