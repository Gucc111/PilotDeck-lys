/**
 * `McpClient` — single-server façade around `@modelcontextprotocol/sdk`'s
 * `Client`. Implements behaviours M1, M2, M3, M5, M6, M14, M15, M16 from
 * the §6.1 contract.
 *
 * - M1 connect() is memoized internally (calling `start` twice yields the
 *   same connection).
 * - M2 transports: `stdio` + `streamable_http` (SSE / WebSocket are
 *   intentionally unsupported in this PR; D-tier).
 * - M3 wraps `callTool` / `listTools` with a configurable timeout
 *   (default 60s; cf. legacy 27.8h — see `intentional_difference`).
 * - M5 / M15 clears closed transports and reconnects expired sessions once.
 *   Only read-only or idempotent calls can be replayed after dispatch.
 * - M5b on `-32001 Request timed out` we recycle the underlying transport
 *   (close + drop refs) before re-throwing, so the *next* `callTool` /
 *   `listTools` spawns a fresh subprocess. Stdio MCP servers like
 *   `@playwright/mcp` can keep an in-flight request pending server-side
 *   after a client timeout (e.g. `page.goto` stuck on a dead TCP
 *   connection), which wedges every follow-up call from the same session.
 * - M6 LRU-caches the result of `listTools()` for `LRU_TTL_MS` (5 min).
 *   Cache is invalidated on reconnect.
 *
 * Errors raised by `callTool` / `listTools` always carry one of the
 * PilotDeck-style `mcp_*` error codes via the `code` field on the thrown
 * error, so the caller can map them back to `PilotDeckToolErrorCode`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import { truncateMcpToolDescription } from "../runtime/truncate.js";
import { buildMcpToolWireName } from "../runtime/wireName.js";
import { networkFetch } from "../../network/fetch.js";
import type {
  PilotDeckMcpServerSpec,
  PilotDeckMcpStatus,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";

const DEFAULT_CALL_TIMEOUT_MS = parseInt(
  process.env.PILOTDECK_MCP_TOOL_TIMEOUT_MS ?? "60000",
  10,
);
const LIST_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000;

export type McpClientOptions = {
  callTimeoutMs?: number;
  /** Connect handshake timeout. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Optional override for testing — supply a pre-built Transport instance. */
  transportFactory?: (spec: PilotDeckMcpServerSpec) => Transport;
  /** Optional fetch override for testing streamable HTTP transports. */
  fetch?: typeof fetch;
};

export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "mcp_handshake_failed"
      | "mcp_call_timeout"
      | "mcp_session_expired"
      | "mcp_call_failed"
      | "mcp_unsupported_transport",
    public readonly serverId?: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

type ListToolsCache = {
  expiresAt: number;
  tools: PilotDeckMcpToolSpec[];
};

export class McpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private status: PilotDeckMcpStatus = "idle";
  private listToolsCache: ListToolsCache | null = null;
  private serverInstructions = "";
  private connectPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private closingPromise: Promise<void> | null = null;
  private generation = 0;
  private cleanupDiagnostic?: string;
  getGeneration(): number { return this.generation; }
  getCleanupDiagnostic(): string | undefined { return this.cleanupDiagnostic; }
  private perSessionDir: string | null = null;

  constructor(
    public readonly spec: PilotDeckMcpServerSpec,
    private readonly options: McpClientOptions = {},
  ) {}

  getStatus(): PilotDeckMcpStatus {
    return this.status;
  }

  getInstructions(): string {
    return this.serverInstructions;
  }

  /** M1 — memoized connect. */
  async start(): Promise<void> {
    if (this.closingPromise) await this.closingPromise;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.runConnect();
    try {
      await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      throw err;
    }
  }

  private async runConnect(): Promise<void> {
    this.status = "connecting";
    const transport = this.buildTransport();
    const client = new Client(
      { name: "pilotdeck", version: "0.1.0" },
      { capabilities: { elicitation: {} } },
    );
    client.onclose = () => {
      // A stopped external server must not leave a memoized, dead connection.
      // Ignore late close events from clients already replaced by reconnect.
      if (this.client !== client) return;
      void this.recycleTransport().catch(() => {});
    };
    const handshakeMs = this.options.handshakeTimeoutMs ?? 10_000;
    try {
      await withTimeout(
        client.connect(transport),
        handshakeMs,
        () =>
          new McpClientError(
            `MCP handshake timed out after ${handshakeMs}ms (server=${this.spec.id})`,
            "mcp_handshake_failed",
            this.spec.id,
          ),
      );
    } catch (err) {
      this.status = "error";
      try { await client.close(); } catch { /* preserve the original handshake failure */ }
      if (this.perSessionDir) { rmSync(this.perSessionDir, { recursive: true, force: true }); this.perSessionDir = null; }
      throw err instanceof McpClientError
        ? err
        : new McpClientError(
            `MCP handshake failed: ${(err as Error).message}`,
            "mcp_handshake_failed",
            this.spec.id,
          );
    }
    this.client = client;
    this.transport = transport;
    this.status = "ready";
    this.generation++;
    this.serverInstructions = client.getInstructions() ?? "";
  }

  private buildTransport(): Transport {
    if (this.options.transportFactory) {
      return this.options.transportFactory(this.spec);
    }
    if (this.spec.transport === "stdio") {
      let args = this.spec.args;
      if (this.spec.perSession) {
        const dir = mkdtempSync(join(tmpdir(), `pilotdeck-mcp-${this.spec.id}-`));
        this.perSessionDir = dir;
        args = [...(args ?? []), `--user-data-dir=${dir}`];
      }
      return new StdioClientTransport({
        command: this.spec.command,
        args,
        env: this.spec.env,
        cwd: this.spec.cwd,
      });
    }
    if (this.spec.transport === "streamable_http") {
      const url = new URL(this.spec.url);
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: this.spec.headers ?? {} },
        fetch: (input, init) => {
          const method = String(init?.method ?? "GET").toUpperCase();
          const fetchImpl = this.options.fetch;
          return (fetchImpl ?? networkFetch)(input as RequestInfo, init, {
            timeoutMs: method === "POST"
              ? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
              : this.options.handshakeTimeoutMs ?? 10_000,
            retry: {
              maxRetries: method === "POST" ? 0 : 1,
              baseDelayMs: 500,
              maxDelayMs: 5_000,
            },
          }).then(response => {
            if (method === "DELETE" && response.status === 405) this.cleanupDiagnostic = "HTTP MCP server does not support session termination; remote session release is unconfirmed.";
            return response;
          });
        },
      });
    }
    const fallback = this.spec as PilotDeckMcpServerSpec;
    throw new McpClientError(
      `Unsupported transport: ${(fallback as { transport: string }).transport}`,
      "mcp_unsupported_transport",
      fallback.id,
    );
  }

  /** M6 — LRU-cached tools/list. */
  async listTools(): Promise<PilotDeckMcpToolSpec[]> {
    const cached = this.listToolsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    await this.start();
    if (!this.client) {
      throw new McpClientError("Client not connected", "mcp_handshake_failed", this.spec.id);
    }
    const tools = await this.callWithReconnect(async () => {
      const result: PilotDeckMcpToolSpec[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.client!.listTools(cursor ? { cursor } : undefined, {
          timeout: this.options.callTimeoutMs ?? this.spec.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        });
        result.push(...page.tools.map(tool => this.toToolSpec(tool)));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new McpClientError("Repeated tools/list pagination cursor", "mcp_call_failed", this.spec.id);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const names = new Set<string>();
      for (const tool of result) {
        if (names.has(tool.wireName)) throw new McpClientError(`Tool name collision: ${tool.wireName}`, "mcp_call_failed", this.spec.id);
        names.add(tool.wireName);
      }
      return result;
    });

    this.listToolsCache = {
      tools,
      expiresAt: Date.now() + LIST_TOOLS_CACHE_TTL_MS,
    };
    return tools;
  }

  /** Reconnect once; only replay tools advertised as read-only or idempotent. */
  async callTool(
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ content: unknown; structuredContent?: unknown; isError?: boolean }> {
    options.signal?.throwIfAborted();
    const tools = await this.listTools();
    options.signal?.throwIfAborted();
    if (!this.client) {
      throw new McpClientError("Client not connected", "mcp_handshake_failed", this.spec.id);
    }
    const timeoutMs = options.timeoutMs ?? this.options.callTimeoutMs ?? this.spec.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const advertisedReplay = (tools: PilotDeckMcpToolSpec[]) => {
      const annotations = tools.find(tool => tool.toolName === toolName)?.annotations;
      return annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
    };
    const mayReplay = advertisedReplay(tools);
    const result = await this.callWithReconnect(() =>
      this.client!.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        {
          timeout: timeoutMs,
          signal: options.signal,
        },
      ), async () => mayReplay && advertisedReplay(await this.listTools()), options.signal,
    );
    return {
      content: recursivelySanitizeUnicode(result.content),
      ...(result.structuredContent === undefined ? {} : {
        structuredContent: recursivelySanitizeUnicode(result.structuredContent),
      }),
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
    };
  }

  /** Recover an expired session without blindly replaying a dispatched mutation. */
  private async callWithReconnect<T>(fn: () => Promise<T>, mayReplay: boolean | (() => Promise<boolean>) = true, signal?: AbortSignal): Promise<T> {
    const dispatchedGeneration = this.generation;
    try {
      return await fn();
    } catch (err) {
      // The SDK can use its timeout error code for cancellation too. Preserve
      // the caller's abort rather than recycling a healthy transport or replaying.
      if (signal?.aborted) throw signal.reason ?? err;
      if (this.isReconnectableError(err)) {
        try {
          if (!this.recoveryPromise && (this.generation === dispatchedGeneration || !this.client)) this.recoveryPromise = this.reconnect().finally(() => { this.recoveryPromise = null; });
          await this.recoveryPromise;
          signal?.throwIfAborted();
          // Retry only if both generations advertise a safe replay. The new
          // server may have removed the annotation while we were disconnected.
          const canReplay = typeof mayReplay === "function" ? await mayReplay() : mayReplay;
          if (!canReplay) {
            throw new McpClientError(
              "MCP connection lost or session expired after dispatch; the action may have executed. Observe current state before retrying.",
              "mcp_session_expired",
              this.spec.id,
            );
          }
          signal?.throwIfAborted();
          return await fn();
        } catch (recoveryError) {
          if (signal?.aborted) throw signal.reason ?? recoveryError;
          if (recoveryError instanceof McpClientError) throw recoveryError;
          throw new McpClientError("MCP recovery or replay failed after dispatch; check the actual operation result.", "mcp_call_failed", this.spec.id);
        }
      }
      if (err instanceof McpClientError) throw err;
      const e = err as Error & { code?: number };
      if (e.code === -32001 || /timed out|timeout/i.test(e.message ?? "")) {
        await this.recycleTransport();
        throw new McpClientError(
          `MCP call timed out (server=${this.spec.id}): ${e.message}`,
          "mcp_call_timeout",
          this.spec.id,
        );
      }
      throw new McpClientError(
        `MCP call failed (server=${this.spec.id}): ${e.message ?? "unknown"}`,
        "mcp_call_failed",
        this.spec.id,
      );
    }
  }

  private isReconnectableError(err: unknown): boolean {
    const e = err as { code?: number; message?: string; statusCode?: number } | null;
    if (!e) return false;
    if (e.statusCode === 404) return true;
    return /session.*expired/i.test(e.message ?? "")
      || e.message === "Not connected"
      || (e.code === -32000 && /connection closed/i.test(e.message ?? ""));
  }

  /** Drop a wedged transport and await local cleanup before opening another.
   * Client cancellation alone does not confirm termination of a remote action.
   */
  private recycleTransport(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.status = "error";
    this.listToolsCache = null;
    const client = this.client, transport = this.transport, directory = this.perSessionDir;
    this.client = null; this.transport = null; this.connectPromise = null; this.perSessionDir = null;
    this.closingPromise = (async () => {
      try {
        await client?.close();
        if (!client) await transport?.close();
        if (directory) rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        // Retain the actual handles so a failed close can be retried without
        // reporting a local release that never happened.
        this.client = client; this.transport = transport; this.perSessionDir = directory;
        throw error;
      }
    })().finally(() => { this.closingPromise = null; });
    return this.closingPromise;
  }

  private async reconnect(): Promise<void> {
    await this.recycleTransport();
    await this.start();
  }

  async close(): Promise<void> {
    if (this.closingPromise) await this.closingPromise;
    this.cleanupDiagnostic = undefined;
    if (this.transport instanceof StreamableHTTPClientTransport && this.transport.sessionId) {
      try { await this.transport.terminateSession(); }
      catch { this.cleanupDiagnostic = "HTTP MCP session termination was not confirmed by the server; the local transport is being closed."; }
    }
    await this.recycleTransport();
    this.status = "idle";
  }

  private toToolSpec(raw: unknown): PilotDeckMcpToolSpec {
    const sanitized = recursivelySanitizeUnicode(raw) as {
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: PilotDeckMcpToolSpec["annotations"];
      _meta?: Record<string, unknown>;
    };
    const wireName = buildMcpToolWireName(this.spec.id, sanitized.name);
    return {
      serverId: this.spec.id,
      toolName: sanitized.name,
      wireName,
      description: truncateMcpToolDescription(sanitized.description ?? ""),
      inputSchema: sanitized.inputSchema ?? { type: "object", properties: {} },
      annotations: sanitized.annotations,
      meta: sanitized._meta,
    };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
