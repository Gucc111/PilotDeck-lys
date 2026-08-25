/** Atomically remove the latest user turn from a normal web-session transcript. */

import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
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
): { transcriptPath: string; safeId: string; backupPath?: string } {
  const chatDir = getPilotProjectChatDir(projectKey, pilotHome);
  const safeId = sanitizeSessionIdForPath(sessionKey);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  return {
    transcriptPath,
    safeId,
    ...(transactionId
      ? { backupPath: resolve(chatDir, `.${safeId}.${transactionId}.replace.bak`) }
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

function createPreservedMetadataEntry(
  entries: AgentTranscriptEntry[],
  preserved: AgentTranscriptEntry[],
  now: Date,
): AgentSessionMetadataTranscriptEntry | undefined {
  const metadata = latestMetadataSnapshot(entries);
  delete metadata.lastPrompt;
  if (!preserved.some((entry) => entry.type === "accepted_input")) {
    delete metadata.firstPrompt;
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

  const preserved = entries.slice(0, latestInputIndex);
  const metadataEntry = createPreservedMetadataEntry(
    entries,
    preserved,
    options.now?.() ?? new Date(),
  );
  const rewrittenEntries = metadataEntry ? [...preserved, metadataEntry] : preserved;
  const body = rewrittenEntries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const originalBody = await readFile(transcriptPath, "utf8");
  const transactionId = randomUUID();
  const { backupPath } = replacementPaths(
    input.sessionKey,
    effectiveProjectRoot,
    options.pilotHome,
    transactionId,
  );
  if (!backupPath) throw new Error("Replacement backup path was not created.");
  const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.replace.tmp`);
  try {
    await writeFile(backupPath, originalBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, transcriptPath);
    await chmod(transcriptPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(backupPath, { force: true }).catch(() => undefined);
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
  const { transcriptPath, safeId, backupPath } = replacementPaths(
    input.sessionKey,
    effectiveProjectRoot,
    options.pilotHome,
    input.transactionId,
  );
  if (!backupPath) throw new Error("Replacement backup path was not created.");

  if (input.action === "commit") {
    await rm(backupPath, { force: true });
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
      await chmod(transcriptPath, 0o600);
      await rm(backupPath, { force: true });
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
