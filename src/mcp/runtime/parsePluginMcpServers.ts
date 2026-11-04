/**
 * Convert the loosely-typed `mcpServers: Record<string, unknown>` blob produced
 * by `PluginRuntime.mcpServers()` (each plugin's manifest) into the strict
 * `PilotDeckMcpServerSpec[]` consumed by `McpRuntime`.
 *
 * Behaviour parity with the legacy upstream plugin manifest schema:
 *   - `command` ⇒ stdio transport (`args`/`env`/`cwd` optional).
 *   - `url` (or `httpUrl`) ⇒ streamable_http transport.
 *   - Anything else is silently dropped — we do **not** throw at startup so
 *     a single misconfigured plugin entry can't take down the gateway.
 */

import { expandMcpString } from "../config/expandPlaceholders.js";
import type { PilotDeckMcpServerSpec } from "../protocol/types.js";

function expandStringRecord(rec: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [k, expandMcpString(v)]),
  );
}

export type ParsePluginMcpServersResult = {
  servers: PilotDeckMcpServerSpec[];
  diagnostics: { id: string; message: string }[];
};

export function parsePluginMcpServers(
  raw: Record<string, unknown> | undefined,
): ParsePluginMcpServersResult {
  const servers: PilotDeckMcpServerSpec[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  if (!raw || typeof raw !== "object") {
    return { servers, diagnostics };
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== "object") {
      diagnostics.push({ id, message: "missing or non-object spec" });
      continue;
    }
    const v = value as Record<string, unknown>;
    const policyError = validateMcpPolicy(v);
    if (policyError) { diagnostics.push({ id, message: policyError }); continue; }
    const policy = {
      connection: (v.connection ?? "separate") as "separate" | "shared",
      usage: (v.usage ?? "concurrent") as "concurrent" | "serial",
      maxConnections: v.maxConnections as number | undefined,
      cwd: typeof v.cwd === "string" ? expandMcpString(v.cwd) : undefined,
    };
    const command = typeof v.command === "string" ? expandMcpString(v.command) : undefined;
    if (command && command.length > 0) {
      servers.push({
        ...policy,
        id,
        transport: "stdio",
        command,
        args: Array.isArray(v.args)
          ? (v.args.filter((a): a is string => typeof a === "string").map(expandMcpString))
          : undefined,
        env: isStringRecord(v.env) ? expandStringRecord(v.env as Record<string, string>) : undefined,
        cwd: typeof v.cwd === "string" ? expandMcpString(v.cwd) : undefined,
        callTimeoutMs: positiveFiniteNumber(v.callTimeoutMs),
        concurrencySafe: typeof v.concurrencySafe === "boolean" ? v.concurrencySafe : undefined,
        perSession: v.perSession === true ? true : undefined,
      });
      continue;
    }
    const url = typeof v.url === "string"
      ? expandMcpString(v.url)
      : typeof v.httpUrl === "string"
        ? expandMcpString(v.httpUrl)
        : undefined;
    if (url) {
      servers.push({
        ...policy,
        id,
        transport: "streamable_http",
        url: expandMcpString(url),
        headers: isStringRecord(v.headers) ? expandStringRecord(v.headers as Record<string, string>) : undefined,
        callTimeoutMs: positiveFiniteNumber(v.callTimeoutMs),
        concurrencySafe: typeof v.concurrencySafe === "boolean" ? v.concurrencySafe : undefined,
      });
      continue;
    }
    diagnostics.push({ id, message: "no recognized transport (need command or url)" });
  }
  return { servers, diagnostics };
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function validateMcpPolicy(value: Record<string, unknown>): string | undefined {
  if (value.connection !== undefined && value.connection !== "separate" && value.connection !== "shared") return 'connection must be "separate" or "shared"';
  if (value.usage !== undefined && value.usage !== "concurrent" && value.usage !== "serial") return 'usage must be "concurrent" or "serial"';
  if (value.maxConnections !== undefined && (!Number.isSafeInteger(value.maxConnections) || (value.maxConnections as number) < 1)) return "maxConnections must be a positive integer";
  if (value.connection === "shared" && value.maxConnections !== undefined && value.maxConnections !== 1) return "shared connections require maxConnections to be omitted or 1";
  return undefined;
}
