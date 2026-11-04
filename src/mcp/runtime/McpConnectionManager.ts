import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { McpClient } from "../client/McpClient.js";
import type { PilotDeckMcpServerSpec, PilotDeckMcpToolSpec } from "../protocol/types.js";

import type { McpOwner, McpState, McpStatus } from "../protocol/management.js";
export type { McpOwner, McpState, McpStatus } from "../protocol/management.js";
export class McpSchedulingError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = true) { super(message); }
}
export type ManagedMcpClient = Pick<McpClient, "spec" | "start" | "listTools" | "callTool" | "close" | "getInstructions"> & {
  getGeneration?: () => number;
  getCleanupDiagnostic?: () => string | undefined;
};
type Entry = {
  id: string; resource: string; policy: string; spec: PilotDeckMcpServerSpec; client: ManagedMcpClient;
  owners: Map<string, McpOwner>; ready: Promise<void>; tools: PilotDeckMcpToolSpec[]; generation?: number;
  phase?: "connect" | "tools"; closing?: Promise<void>; closeFailed?: boolean; active: number; refresh?: Promise<void>;
};
type Resource = { entries: Set<Entry>; queue: object[]; running: boolean; unknown: boolean };
type OwnerRecord = { owner: McpOwner; controller: AbortController; entries: Map<string, Entry>; preparing: boolean; active: number; tools: Map<string, PilotDeckMcpToolSpec[]>; generations: Map<string, number | undefined> };
export type McpManagerOptions = {
  waitTimeoutMs?: number;
  createClient?: (spec: PilotDeckMcpServerSpec, connectionId: string) => ManagedMcpClient;
  onStatus?: (status: McpStatus) => void;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const ownerKey = (owner: McpOwner) => canonical(owner);
/** Stable effective configuration only: generated browser directories belong to the client. */
export function mcpResourceId(spec: PilotDeckMcpServerSpec): string {
  const { connection: _c, usage: _u, maxConnections: _m, concurrencySafe: _s, callTimeoutMs: _t, ...config } = spec;
  return digest({ ...config, cwd: resolve(spec.cwd ?? process.cwd()) });
}
const policyId = (spec: PilotDeckMcpServerSpec) => digest({ connection: spec.connection ?? "separate", usage: spec.usage ?? "concurrent", maxConnections: spec.maxConnections ?? null, callTimeoutMs: spec.callTimeoutMs, concurrencySafe: spec.concurrencySafe });

/** One Gateway owns all physical clients. Reservations are synchronous and atomic across a batch. */
export class McpConnectionManager {
  private readonly resources = new Map<string, Resource>();
  private readonly owners = new Map<string, OwnerRecord>();
  private readonly waiters = new Set<() => void>();
  private readonly statuses = new Map<string, McpStatus>();
  private stopped = false;
  constructor(private readonly options: McpManagerOptions = {}) {}
  private wake(): void { for (const listener of [...this.waiters]) listener(); }
  private resource(id: string): Resource {
    let resource = this.resources.get(id);
    if (!resource) { resource = { entries: new Set(), queue: [], running: false, unknown: false }; this.resources.set(id, resource); }
    return resource;
  }
  private emit(spec: PilotDeckMcpServerSpec, owner: McpOwner | undefined, state: McpState, stage: McpStatus["stage"], reason?: string, connectionId?: string): void {
    const resourceId = mcpResourceId(spec);
    if (state === "ready" && this.resource(resourceId).unknown) { state = "unknown"; stage = "call"; reason = "The previous operation may still be executing. Check actual results before resetting the resource."; }
    const status: McpStatus = { serverId: spec.id, resourceId, state, stage, owner, connectionId, holders: [...this.resource(resourceId).entries].flatMap(e => [...e.owners.values()]), retryable: state !== "unknown", reason };
    this.statuses.set(`${resourceId}:${owner ? ownerKey(owner) : "cleanup"}`, status);
    this.options.onStatus?.(status);
  }
  reportUnavailable(owner: McpOwner, serverId: string): void {
    const resourceId = digest({ serverId, unavailable: true });
    const status: McpStatus = { serverId, resourceId, owner, holders: [], state: "failed", stage: "connect", retryable: true, reason: "Optional MCP configuration is unavailable; execution will continue without this capability" };
    this.statuses.set(`${resourceId}:${ownerKey(owner)}`, status); this.options.onStatus?.(status);
  }
  snapshot(): McpStatus[] {
    return [...this.statuses.values()].map(status => ({ ...status, holders: [...this.resource(status.resourceId).entries].flatMap(e => [...e.owners.values()]) }));
  }
  private async changed(signal: AbortSignal, deadline: number): Promise<void> {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new McpSchedulingError("mcp_wait_timeout", "MCP wait exceeded 120 seconds. Release an idle holder and retry.");
    await new Promise<void>((resolveWait, reject) => {
      const done = (error?: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.waiters.delete(notify); error ? reject(error) : resolveWait(); };
      const notify = () => done();
      const abort = () => done(signal.reason ?? new Error("MCP wait cancelled"));
      const timer = setTimeout(() => done(new McpSchedulingError("mcp_wait_timeout", "MCP wait timed out; retry after releasing an idle holder.")), Math.max(0, deadline - Date.now()));
      this.waiters.add(notify); signal.addEventListener("abort", abort, { once: true });
    });
  }
  async acquire(owner: McpOwner, specs: PilotDeckMcpServerSpec[], signal?: AbortSignal, optionalIds: ReadonlySet<string> = new Set()): Promise<McpLease> {
    if (this.stopped) throw new Error("MCP manager closed");
    const key = ownerKey(owner);
    let record = this.owners.get(key);
    if (new Set(specs.map(spec => spec.id)).size !== specs.length) throw new Error("Duplicate MCP IDs in preparation batch");
    if (!record) { record = { owner, controller: new AbortController(), entries: new Map(), preparing: false, active: 0, tools: new Map(), generations: new Map() }; this.owners.set(key, record); }
    if (record.preparing) throw new Error("MCP owner is already preparing");
    record.preparing = true;
    const combined = signal ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal;
    const added: Entry[] = [];
    const deadline = Date.now() + (this.options.waitTimeoutMs ?? 120_000);
    try {
      for (;;) {
        combined.throwIfAborted();
        if (this.stopped) throw new Error("MCP manager closed");
        const blocked = specs.filter(spec => {
          const id = mcpResourceId(spec), policy = policyId(spec), resource = this.resource(id);
          const existing = record!.entries.get(spec.id);
          if (existing && existing.resource === id && existing.policy === policy && !existing.closing) return false;
          if (existing) throw new Error(`MCP ${spec.id} changed while its owner still holds a previous version`);
          if ([...resource.entries].some(e => e.policy !== policy || e.closing || e.closeFailed)) return true;
          if (spec.connection === "shared" && resource.entries.size) return false;
          return resource.entries.size >= (spec.connection === "shared" ? 1 : spec.maxConnections ?? Infinity);
        });
        if (!blocked.length) break;
        for (const spec of blocked) this.emit(spec, owner, "waiting_capacity", "capacity", "Waiting for connection capacity or the previous configuration version to be released");
        await this.changed(combined, deadline);
      }
      // No await until every required slot has been reserved.
      for (const spec of specs) {
        if (record.entries.has(spec.id)) continue;
        const resourceId = mcpResourceId(spec), resource = this.resource(resourceId);
        let entry = spec.connection === "shared" ? [...resource.entries][0] : undefined;
        if (!entry) {
          const id = randomUUID();
          const client = this.options.createClient?.(spec, id) ?? new McpClient(spec);
          entry = { id, resource: resourceId, policy: policyId(spec), spec, client, owners: new Map(), ready: Promise.resolve(), tools: [], active: 0 };
          resource.entries.add(entry);
          const reserved = entry;
          // Start after all reservations in this synchronous section.
          entry.ready = Promise.resolve().then(async () => {
            reserved.phase = "connect";
            this.emit(spec, owner, "connecting", "connect", undefined, id);
            await client.start();
            reserved.phase = "tools";
            this.emit(spec, owner, "connecting", "tools", undefined, id);
            reserved.tools = await client.listTools();
            reserved.generation = client.getGeneration?.();
            this.checkNames(reserved.tools);
            this.emit(spec, owner, "ready", "tools", undefined, id);
          });
          void entry.ready.catch(() => {});
        }
        entry.owners.set(key, owner); record.entries.set(spec.id, entry); added.push(entry);
        // Every owner must be visible and cancellable while a coalesced
        // handshake is pending, not just the owner that created the client.
        this.emit(spec, owner, "connecting", entry.phase ?? "connect", undefined, entry.id);
      }
      const missing: string[] = [];
      const ready = Promise.all([...record.entries.values()].map(async entry => {
        try { await entry.ready; }
        catch (error) {
          if (!optionalIds.has(entry.spec.id)) throw error;
          missing.push(entry.spec.id);
          this.emit(entry.spec, owner, "failed", "tools", "Optional MCP unavailable; execution will continue without this capability");
          await this.detach(key, record!, entry);
        }
      }));
      await this.abortable(ready, combined);
      this.checkNames([...record.entries.values()].flatMap(e => e.tools));
      for (const entry of record.entries.values()) this.emit(entry.spec, owner, "ready", "tools", undefined, entry.id);
      for (const entry of record.entries.values()) { record.tools.set(entry.spec.id, entry.tools); record.generations.set(entry.spec.id, entry.generation); }
      return new McpLease(this, owner, record.entries, record.tools, missing);
    } catch (error) {
      for (const spec of specs) {
        const entry = record.entries.get(spec.id);
        const previous = this.statuses.get(`${mcpResourceId(spec)}:${key}`);
        const code = (error as { code?: string }).code;
        this.emit(spec, owner, "failed", entry?.phase ?? previous?.stage ?? "capacity", combined.aborted ? "MCP preparation cancelled" : `MCP preparation failed (${code ?? "connection_or_tool_discovery_failed"}); retry after checking this server`);
      }
      const cleanup = Promise.allSettled(added.map(entry => this.detach(key, record!, entry))).then(() => {
        if (!record!.entries.size && this.owners.get(key) === record) this.owners.delete(key);
      });
      // A cancelled caller need not wait for a handshake to time out. Physical
      // reservations remain counted until asynchronous cleanup actually closes.
      if (combined.aborted) void cleanup; else await cleanup;
      throw error;
    } finally { record.preparing = false; }
  }
  private checkNames(tools: PilotDeckMcpToolSpec[]): void {
    const names = new Set<string>();
    for (const tool of tools) { if (names.has(tool.wireName)) throw new McpSchedulingError("mcp_tool_collision", `MCP tool name collision: ${tool.wireName}`, false); names.add(tool.wireName); }
  }
  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolveValue, reject) => {
      const abort = () => reject(signal.reason ?? new Error("MCP cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolveValue, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async refresh(owner: McpOwner, signal?: AbortSignal): Promise<void> {
    const record = this.owners.get(ownerKey(owner));
    if (!record || record.controller.signal.aborted) throw new Error("MCP owner released");
    const combined = signal ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal;
    combined.throwIfAborted();
    for (const entry of record.entries.values()) {
      if (!entry.refresh) entry.refresh = (async () => {
        await entry.client.start();
        const tools = await entry.client.listTools();
        this.checkNames(tools); entry.tools = tools; entry.generation = entry.client.getGeneration?.();
      })().finally(() => { entry.refresh = undefined; });
      try { await this.abortable(entry.refresh, combined); }
      catch (error) { this.emit(entry.spec, owner, "failed", "tools", combined.aborted ? "MCP tool refresh cancelled" : "MCP tool refresh failed; retry before requesting the model", entry.id); throw error; }
    }
    this.checkNames([...record.entries.values()].flatMap(e => e.tools));
    for (const entry of record.entries.values()) { record.tools.set(entry.spec.id, entry.tools); record.generations.set(entry.spec.id, entry.generation); }
  }
  async call(owner: McpOwner, serverId: string, tool: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const record = this.owners.get(ownerKey(owner)), entry = record?.entries.get(serverId);
    if (!record || !entry) throw new Error(`MCP ${serverId} is not authorized for this owner`);
    const signal = options.signal ? AbortSignal.any([options.signal, record.controller.signal]) : record.controller.signal;
    signal.throwIfAborted();
    const resource = this.resource(entry.resource), serial = entry.spec.usage === "serial", token = {};
    const deadline = Date.now() + (this.options.waitTimeoutMs ?? 120_000);
    let dispatched = false, ownsLock = false, connectionInUse = false;
    record.active++;
    if (serial) resource.queue.push(token);
    try {
      if (serial) {
        while (resource.running || resource.queue[0] !== token) {
          if (resource.unknown) throw new McpSchedulingError("mcp_execution_unknown", "Previous MCP operation may still be running. Check its actual result and reset the resource.", false);
          this.emit(entry.spec, owner, "waiting_call", "call");
          await this.changed(signal, deadline);
        }
        if (resource.unknown) throw new McpSchedulingError("mcp_execution_unknown", "MCP execution state unknown. Check the actual result before resetting.", false);
        resource.running = true; ownsLock = true;
      }
      signal.throwIfAborted();
      entry.active++; connectionInUse = true;
      // A reconnect must never silently execute a definition the model did not see.
      await entry.client.start();
      signal.throwIfAborted();
      if (record.generations.get(serverId) !== entry.client.getGeneration?.() || canonical(record.tools.get(serverId)) !== canonical(entry.tools)) throw new McpSchedulingError("mcp_capabilities_changed", "MCP reconnected. Tools must be refreshed before the next model request.");
      dispatched = true;
      const result = await entry.client.callTool(tool, args, { ...options, signal });
      this.emit(entry.spec, owner, "ready", "call", undefined, entry.id);
      return result;
    } catch (error) {
      // Any transport/recovery failure after dispatch leaves remote completion
      // unconfirmed. MCP application failures are returned as isError results.
      if (serial && dispatched) {
        resource.unknown = true;
        this.emit(entry.spec, owner, "unknown", "call", "The operation may still be executing. Check actual results before resetting the resource.", entry.id);
      } else if (resource.unknown) {
        this.emit(entry.spec, owner, "unknown", "call", "The previous operation may still be executing. Check actual results before resetting the resource.", entry.id);
      } else {
        this.emit(entry.spec, owner, "failed", "call", signal.aborted ? "MCP call wait cancelled" : "MCP call could not start; refresh capabilities or retry after checking capacity", entry.id);
      }
      throw error;
    } finally {
      record.active--; if (connectionInUse) entry.active--;
      if (serial) { const index = resource.queue.indexOf(token); if (index >= 0) resource.queue.splice(index, 1); if (ownsLock) resource.running = false; }
      this.wake();
    }
  }
  private async detach(key: string, record: OwnerRecord, entry: Entry): Promise<void> {
    entry.owners.delete(key);
    if (entry.owners.size) { record.entries.delete(entry.spec.id); record.tools.delete(entry.spec.id); record.generations.delete(entry.spec.id); this.wake(); return; }
    if (!entry.closing) {
      entry.closing = (async () => {
        await entry.ready.catch(() => {});
        await entry.refresh?.catch(() => {});
        // Keep capacity until the last in-flight call has settled.
        while (entry.active) await new Promise<void>(resolveWait => { const listener = () => { this.waiters.delete(listener); resolveWait(); }; this.waiters.add(listener); });
        try {
          await entry.client.close();
          entry.closeFailed = false;
          const diagnostic = entry.client.getCleanupDiagnostic?.();
          if (diagnostic) this.emit(entry.spec, undefined, "failed", "cleanup", diagnostic, entry.id);
          this.resource(entry.resource).entries.delete(entry);
        } catch (error) {
          entry.closeFailed = true;
          this.emit(entry.spec, undefined, "failed", "cleanup", "Local MCP transport cleanup failed; release can be retried", entry.id);
          throw error;
        } finally { entry.closing = undefined; this.wake(); }
      })();
    }
    await entry.closing; record.entries.delete(entry.spec.id); record.tools.delete(entry.spec.id); record.generations.delete(entry.spec.id);
  }
  cancel(owner: McpOwner): void { this.owners.get(ownerKey(owner))?.controller.abort(new Error("MCP owner cancelled")); this.wake(); }
  async release(owner: McpOwner, idleOnly = false): Promise<void> {
    const key = ownerKey(owner), record = this.owners.get(key);
    if (!record) {
      for (const [id, status] of this.statuses) if (status.owner && ownerKey(status.owner) === key && status.state !== "unknown") this.statuses.delete(id);
      return;
    }
    if (idleOnly && (record.active || record.preparing)) throw new McpSchedulingError("mcp_owner_busy", "MCP owner is executing or preparing a model request", false);
    record.controller.abort(new Error("MCP owner released")); this.wake();
    await Promise.all([...record.entries.values()].map(entry => this.detach(key, record, entry)));
    if (this.owners.get(key) === record) this.owners.delete(key);
    for (const [id, status] of this.statuses) if (status.owner && ownerKey(status.owner) === key && status.state !== "unknown") this.statuses.delete(id);
  }
  ownerList(): McpOwner[] { return [...this.owners.values()].map(record => record.owner); }
  reset(resourceId: string): void {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.running || [...resource.entries].some(e => e.active)) throw new Error("Resource is missing or still in use");
    resource.unknown = false;
    for (const status of this.statuses.values()) if (status.resourceId === resourceId && status.state === "unknown") { status.state = "ready"; status.reason = undefined; this.options.onStatus?.(status); }
    this.wake();
  }
  async close(): Promise<void> { this.stopped = true; for (const owner of this.ownerList()) this.cancel(owner); await Promise.all(this.ownerList().map(owner => this.release(owner))); }
}

/** Session facade has references and a tool snapshot; it never owns physical clients. */
export class McpLease {
  constructor(private readonly manager: McpConnectionManager, public readonly owner: McpOwner, private readonly entries: Map<string, Entry>, private readonly tools: Map<string, PilotDeckMcpToolSpec[]>, public readonly missing: string[] = []) {}
  async listAllTools(): Promise<PilotDeckMcpToolSpec[]> { return [...this.tools.values()].flat(); }
  getClient(serverId: string) {
    const entry = this.entries.get(serverId);
    return entry ? { spec: entry.client.spec, callTool: (tool: string, args: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => this.manager.call(this.owner, serverId, tool, args, options) } : undefined;
  }
  getInstructions() { return [...this.entries.values()].map(entry => ({ serverId: entry.spec.id, instructions: entry.client.getInstructions() })).filter(item => item.instructions.trim()); }
  refresh(signal?: AbortSignal): Promise<void> { return this.manager.refresh(this.owner, signal); }
  stop(): Promise<void> { return this.manager.release(this.owner); }
}
