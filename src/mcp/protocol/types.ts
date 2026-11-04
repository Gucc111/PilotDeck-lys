/**
 * MCP runtime protocol (C1 §6.1 of the deferred-feature guide).
 * Mirrors the legacy contracts in `services/mcp/client.ts` (M1-M16).
 */

export type McpConnectionPolicy = {
  connection?: "separate" | "shared";
  usage?: "concurrent" | "serial";
  maxConnections?: number;
  /** Effective working directory also participates in HTTP connection identity. */
  cwd?: string;
};

export type PilotDeckMcpServerSpec = McpConnectionPolicy & (
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      /** Optional per-server tool timeout for slow first-load operations. */
      callTimeoutMs?: number;
      /** False opts read-only tools out of parallel tool batches (not a session lock). */
      concurrencySafe?: boolean;
      /**
       * When true, the MCP runtime injects a unique `--user-data-dir` per
       * connection so compatible MCP clients get their own temporary
       * browser profile on disk.  The temp directory is cleaned up when the
       * client closes.
       */
      perSession?: boolean;
    }
  | {
      id: string;
      transport: "streamable_http";
      url: string;
      headers?: Record<string, string>;
      /** Optional per-server tool timeout for slow first-load operations. */
      callTimeoutMs?: number;
      /** False opts read-only tools out of parallel tool batches (not a session lock). */
      concurrencySafe?: boolean;
    });

export type PilotDeckMcpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
};

/**
 * Runtime view of a tool advertised by an MCP server. Already sanitized
 * (M9), wire-named (M10), and description-truncated (M11).
 */
export type PilotDeckMcpToolSpec = {
  serverId: string;
  toolName: string;
  wireName: string;
  description: string;
  inputSchema: unknown;
  annotations?: PilotDeckMcpToolAnnotations;
  meta?: Record<string, unknown>;
};

export type PilotDeckMcpStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "error"
  | "needs-auth";

export type PilotDeckMcpServerInstructions = {
  serverId: string;
  instructions: string;
};

export type PilotDeckMcpClientStatusEntry = {
  serverId: string;
  status: PilotDeckMcpStatus;
  error?: string;
};
