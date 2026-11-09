import { randomUUID } from "node:crypto";
import { mkdir, appendFile, open, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import {
  classifyDurableMessageEntry,
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  type AgentControlBoundaryTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentSubagentCompletedTranscriptEntry,
  type AgentSubagentStartedTranscriptEntry,
  type AgentTranscriptEntry,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type SubagentTranscriptHandle = {
  /** UUID v4 of the subagent (matches sidechain filename). */
  subagentId: string;
  /** The sidechain writer (independent JSONL file). */
  writer: JsonlTranscriptWriter;
  /** Absolute path of the sidechain transcript. */
  transcriptPath: string;
};

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
  /**
   * Optional resolver mapping a subagentId → absolute sidechain path. Wired
   * by the parent session so {@link JsonlTranscriptWriter#forSubagent} can
   * derive a sidechain writer without the caller computing paths. Defaults
   * to `<dirname(path)>/<subagentId>.jsonl`.
   */
  subagentTranscriptPath?: (subagentId: string) => string;
};

type TranscriptAppendCoordinator = {
  path: string;
  sequence: number;
  transcriptOrder: number;
  lastEntryId: string | null;
  initialized: boolean;
  initializePromise?: Promise<void>;
  tailPrepared: boolean;
  chain: Promise<void>;
};

const coordinators = new Map<string, TranscriptAppendCoordinator>();

function coordinatorFor(path: string): TranscriptAppendCoordinator {
  const normalized = resolve(path);
  let coordinator = coordinators.get(normalized);
  if (!coordinator) {
    coordinator = {
      path: normalized,
      sequence: 0,
      transcriptOrder: 0,
      lastEntryId: null,
      initialized: false,
      tailPrepared: false,
      chain: Promise.resolve(),
    };
    coordinators.set(normalized, coordinator);
  }
  return coordinator;
}

async function initializeCoordinator(coordinator: TranscriptAppendCoordinator): Promise<void> {
  if (coordinator.initialized) return;
  if (!coordinator.initializePromise) {
    coordinator.initializePromise = (async () => {
      try {
        const content = await readFile(coordinator.path, "utf8");
        let validOrder = 0;
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line) as Partial<AgentTranscriptEntry>;
            if (typeof value.sequence !== "number" || !Number.isFinite(value.sequence)) continue;
            validOrder += 1;
            coordinator.sequence = Math.max(coordinator.sequence, value.sequence);
            if (typeof value.transcriptOrder === "number" && Number.isFinite(value.transcriptOrder)) {
              coordinator.transcriptOrder = Math.max(coordinator.transcriptOrder, value.transcriptOrder);
            } else {
              coordinator.transcriptOrder = Math.max(coordinator.transcriptOrder, validOrder);
            }
            if (typeof value.entryId === "string") coordinator.lastEntryId = value.entryId;
          } catch {
            // Leave malformed crash debris in place; prepareTail will ensure
            // the next valid record starts on a new line.
          }
        }
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      coordinator.initialized = true;
    })();
  }
  await coordinator.initializePromise;
}

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly now: () => Date;
  private readonly coordinator: TranscriptAppendCoordinator;
  private readonly options: JsonlTranscriptWriterOptions;

  constructor(options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
    const normalized = resolve(options.path);
    this.coordinator = coordinatorFor(normalized);
    this.options = { ...options, path: normalized };
  }

  /**
   * Re-seed the shared per-path counters from a previously persisted
   * transcript. A stale resume path can never move the shared counter back.
   */
  restoreState(maxSequence: number, lastEntryId: string | null): void {
    const previousSequence = this.coordinator.sequence;
    this.sequence = Math.max(this.sequence, maxSequence);
    this.coordinator.sequence = Math.max(this.coordinator.sequence, maxSequence);
    if (lastEntryId && maxSequence >= previousSequence) this.coordinator.lastEntryId = lastEntryId;
  }

  snapshotState(): AgentTranscriptWriterState {
    return {
      sequence: Math.max(this.sequence, this.coordinator.sequence),
      lastEntryId: this.coordinator.lastEntryId ?? this.lastEntryId,
    };
  }

  private lastEntryId: string | null = null;

  recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[], metadata?: Record<string, unknown>): Promise<void> {
    return this.recordWithBase(sessionId, turnId, base => ({
      type: "accepted_input", ...base, messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    }));
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.recordWithBase(sessionId, turnId, base => ({ type, ...base, message }));
  }

  recordAgentStatusMessage(sessionId: string, turnId: string, status: { event: string; kind: "status" | "error"; text: string; detail?: Record<string, unknown> }): Promise<void> {
    return this.recordWithBase(sessionId, turnId, base => ({
      type: "agent_status_message", ...base, event: status.event, kind: status.kind, text: status.text,
      ...(status.detail && Object.keys(status.detail).length > 0 ? { detail: status.detail } : {}),
    }));
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): Promise<void> {
    if (artifacts.length === 0) return Promise.resolve();
    return this.recordWithBase(sessionId, turnId, base => ({ type: "file_artifacts", ...base, artifacts }));
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.recordWithBase(sessionId, turnId, base => ({ type: "turn_result", ...base, result }));
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.recordWithBase(sessionId, turnId, base => ({ type: "session_metadata", ...base, metadata }));
  }

  recordControlBoundary(sessionId: string, turnId: string, boundary: AgentControlBoundaryTranscriptEntry["boundary"]): Promise<void> {
    return this.recordWithBase(sessionId, turnId, base => ({ type: "control_boundary", ...base, boundary }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (!this.closePromise) {
      const pending = this.coordinator.chain.catch(() => undefined);
      this.closePromise = pending.then(() => {
        this.closed = true;
      });
    }
    await this.closePromise;
  }

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    return this.enqueue(() => entry, entry);
  }

  private recordWithBase(
    sessionId: string,
    turnId: string,
    build: (base: Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId" | "transcriptOrder">) => AgentTranscriptEntry,
  ): Promise<void> {
    return this.enqueue(state => build({
      sessionId,
      turnId,
      sequence: state.sequence + 1,
      createdAt: this.now().toISOString(),
      entryId: randomUUID(),
      parentEntryId: state.lastEntryId,
      transcriptOrder: state.transcriptOrder + 1,
    }));
  }

  private enqueue(factory: (state: { sequence: number; transcriptOrder: number; lastEntryId: string | null }) => AgentTranscriptEntry, explicit?: AgentTranscriptEntry): Promise<void> {
    if (this.closed || this.closing) return Promise.resolve();
    const flush = explicit?.type === "control_boundary" &&
      (explicit.boundary.kind === "restore" || (explicit.boundary.kind === "compact" && explicit.boundary.subtype === "compact_boundary"));
    const previous = this.coordinator.chain.catch(() => undefined);
    const next = previous.then(async () => {
      if (this.closed) return;
      await initializeCoordinator(this.coordinator);
      const entry = explicit ?? factory({ sequence: this.coordinator.sequence, transcriptOrder: this.coordinator.transcriptOrder, lastEntryId: this.coordinator.lastEntryId });
      const sequence = Number.isFinite(entry.sequence) && entry.sequence > this.coordinator.sequence
        ? entry.sequence
        : this.coordinator.sequence + 1;
      const requestedTranscriptOrder = entry.transcriptOrder;
      const transcriptOrder = typeof requestedTranscriptOrder === "number" && Number.isFinite(requestedTranscriptOrder) && requestedTranscriptOrder > this.coordinator.transcriptOrder
        ? requestedTranscriptOrder
        : this.coordinator.transcriptOrder + 1;
      const persistedEntry = { ...entry, sequence, transcriptOrder };
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await this.prepareTail();
      await appendFile(this.options.path, `${JSON.stringify(persistedEntry)}\n`, { encoding: "utf8", mode: 0o600, flush });
      this.coordinator.sequence = sequence;
      this.coordinator.transcriptOrder = transcriptOrder;
      this.coordinator.lastEntryId = persistedEntry.entryId ?? this.coordinator.lastEntryId;
      this.sequence = this.coordinator.sequence;
      this.lastEntryId = this.coordinator.lastEntryId;
    });
    // A failed append must reject its own receipt without poisoning later
    // appends queued for the same transcript.
    this.coordinator.chain = next.catch(() => undefined);
    return next;
  }

  private async prepareTail(): Promise<void> {
    if (this.coordinator.tailPrepared) return;
    const file = await open(this.options.path, "a+", 0o600);
    try {
      const { size } = await file.stat();
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        await file.read(lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) await file.appendFile("\n");
      }
      this.coordinator.tailPrepared = true;
    } finally {
      await file.close();
    }
  }

  async recordSubagentStarted(sessionId: string, turnId: string, args: { subagentId: string; subagentType: string; prompt: string; transcriptRelativePath: string; subagentSessionId?: string }): Promise<void> {
    const { preview, truncated } = truncatePreview(args.prompt, SUBAGENT_PROMPT_PREVIEW_BYTES);
    return this.recordWithBase(sessionId, turnId, base => ({ type: "subagent_started", ...base, subagentId: args.subagentId, subagentType: args.subagentType, promptPreview: preview, promptTruncated: truncated, transcriptRelativePath: args.transcriptRelativePath, subagentSessionId: args.subagentSessionId }));
  }

  async recordSubagentCompleted(sessionId: string, turnId: string, args: { subagentId: string; subagentType: string; summary: string; usage?: AgentSubagentCompletedTranscriptEntry["usage"]; turns: number; durationMs: number; errored?: boolean }): Promise<void> {
    const { preview, truncated } = truncatePreview(args.summary, SUBAGENT_SUMMARY_PREVIEW_BYTES);
    return this.recordWithBase(sessionId, turnId, base => ({ type: "subagent_completed", ...base, subagentId: args.subagentId, subagentType: args.subagentType, summaryPreview: preview, summaryTruncated: truncated, usage: args.usage, turns: args.turns, durationMs: args.durationMs, errored: args.errored }));
  }

  forSubagent(subagentId: string, now?: () => Date): SubagentTranscriptHandle {
    const path = this.options.subagentTranscriptPath?.(subagentId) ?? defaultSubagentPath(this.options.path, subagentId);
    const writer = new JsonlTranscriptWriter({ path, now: now ?? this.now });
    return { subagentId, writer, transcriptPath: path };
  }

  relativeSubagentPath(subagentId: string): string {
    const sidechain = this.options.subagentTranscriptPath?.(subagentId) ?? defaultSubagentPath(this.options.path, subagentId);
    return relative(dirname(this.options.path), sidechain);
  }
}

function defaultSubagentPath(parentPath: string, subagentId: string): string {
  const dir = dirname(parentPath);
  const stem = basename(parentPath).replace(/\.jsonl$/i, "");
  return join(dir, stem, "subagents", `${subagentId}.jsonl`);
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
