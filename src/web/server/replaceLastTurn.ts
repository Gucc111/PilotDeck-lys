/** Atomically remove the latest user turn from a normal web-session transcript. */

import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import type { AgentAcceptedInputTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type {
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../client/protocol.js";

export type ReplaceLastWebSessionTurnOptions = {
  projectRoot: string;
  pilotHome: string;
};

export class ReplaceLastTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReplaceLastTurnError";
  }
}

function findLatestAcceptedInput(
  entries: Awaited<ReturnType<typeof readTranscript>>["entries"],
): AgentAcceptedInputTranscriptEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "accepted_input") return entry;
  }
  return undefined;
}

export async function replaceLastWebSessionTurn(
  input: WebReplaceLastTurnInput,
  options: ReplaceLastWebSessionTurnOptions,
): Promise<WebReplaceLastTurnResult> {
  if (!input.sessionKey?.trim() || !input.expectedTurnId?.trim()) {
    throw new ReplaceLastTurnError(
      "replace_invalid_input",
      "sessionKey and expectedTurnId are required.",
    );
  }

  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(input.sessionKey);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  const { entries, diagnostics } = await readTranscript(transcriptPath);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ReplaceLastTurnError(
      "replace_invalid_transcript",
      "The conversation transcript could not be safely rewritten.",
    );
  }

  const latestInput = findLatestAcceptedInput(entries);
  if (!latestInput) {
    throw new ReplaceLastTurnError("replace_empty_transcript", "No user turn is available to replace.");
  }
  if (latestInput.turnId !== input.expectedTurnId) {
    throw new ReplaceLastTurnError(
      "replace_turn_conflict",
      "The selected message is no longer the latest user turn.",
    );
  }

  const preserved = entries.filter((entry) => entry.sequence < latestInput.sequence);
  const body = preserved.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const temporaryPath = resolve(dirname(transcriptPath), `.${safeId}.${randomUUID()}.replace.tmp`);
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, transcriptPath);
    await chmod(transcriptPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    sessionKey: input.sessionKey,
    replacedTurnId: latestInput.turnId,
    removedEntryCount: entries.length - preserved.length,
  };
}
