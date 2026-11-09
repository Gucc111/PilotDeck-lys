import { readFile, stat } from "node:fs/promises";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry } from "./TranscriptEntry.js";

export const DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024;

export type AgentTranscriptReadResult = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

export type ReadTranscriptOptions = {
  maxBytes?: number;
};

export async function readTranscript(path: string, options: ReadTranscriptOptions = {}): Promise<AgentTranscriptReadResult> {
  let content: string;
  try {
    const fileStat = await stat(path);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES;
    if (fileStat.size > maxBytes) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_too_large",
            severity: "error",
            message: `Transcript ${path} is larger than ${maxBytes} bytes.`,
          },
        ],
      };
    }
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_missing",
            severity: "warning",
            message: `Transcript ${path} does not exist.`,
          },
        ],
      };
    }
    throw error;
  }

  const entries: AgentTranscriptEntry[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  let physicalOrder = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTranscriptEntry(parsed)) {
        physicalOrder += 1;
        entries.push({ ...parsed, transcriptOrder: physicalOrder });
      } else {
        diagnostics.push({
          code: "transcript_entry_invalid",
          severity: "error",
          message: "Transcript entry has an invalid shape.",
          line: index + 1,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "transcript_line_invalid",
        severity: "error",
        message: error instanceof Error ? error.message : "Transcript line is not valid JSON.",
        line: index + 1,
      });
    }
  }

  // New transcripts have a unique monotonic sequence. Legacy transcripts can
  // contain sequence resets from short-lived writers; in that case the
  // physical append order is the only trustworthy display order. Keep the
  // original sequence and entry references intact for replay/diagnostics.
  let previousSequence: number | undefined;
  const sequenceIsMonotonic = entries.every((entry) => {
    const valid = previousSequence === undefined || entry.sequence > previousSequence;
    previousSequence = entry.sequence;
    return valid;
  });
  entries.sort((left, right) => {
    if (!sequenceIsMonotonic) return (left.transcriptOrder ?? 0) - (right.transcriptOrder ?? 0);
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return (left.transcriptOrder ?? 0) - (right.transcriptOrder ?? 0);
  });
  return { entries, diagnostics };
}

function isTranscriptEntry(value: unknown): value is AgentTranscriptEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
