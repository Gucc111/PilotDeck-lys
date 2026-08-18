import { fetch as undiciFetch } from "undici";
import { getDiagnosticLogger, sanitizeUrlForDiagnostics, serializeErrorForDiagnostics } from "../diagnostics/logger.js";

export type NetworkErrorCode =
  | "network_timeout"
  | "network_dns_error"
  | "network_connection_reset"
  | "network_connection_refused"
  | "network_tls_error"
  | "network_proxy_error"
  | "network_rate_limited"
  | "network_server_error"
  | "network_abort"
  | "network_fetch_failed";

export class NetworkFetchError extends Error {
  readonly name = "NetworkFetchError";

  constructor(
    readonly code: NetworkErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type NetworkRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnPost?: boolean;
  retryStatuses?: readonly number[];
};

export type NetworkFetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: NetworkRetryOptions;
  fetchImpl?: typeof fetch;
  diagnostics?: {
    module?: string;
    event?: string;
    provider?: string;
    model?: string;
    sessionKey?: string;
    projectKey?: string;
    runId?: string;
    turnId?: string;
    metadata?: Record<string, unknown>;
  };
};

export type NetworkJsonOptions = NetworkFetchOptions & {
  expectedStatuses?: readonly number[];
};

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function networkFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkFetchOptions = {},
): Promise<Response> {
  const retry = options.retry ?? {};
  const maxRetries = Math.max(0, retry.maxRetries ?? 0);
  const method = resolveMethod(input, init);
  const canRetryMethod = SAFE_METHODS.has(method) || retry.retryOnPost === true;
  const parentSignal = options.signal ?? (init.signal instanceof AbortSignal ? init.signal : undefined);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const detachAbort = parentSignal ? forwardAbort(parentSignal, controller) : undefined;
    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => controller.abort(new NetworkFetchError("network_timeout", `Network request timed out after ${options.timeoutMs}ms.`)), options.timeoutMs)
      : undefined;

    try {
      if (options.diagnostics && getDiagnosticLogger().config.networkDiagnostics) {
        getDiagnosticLogger().debug({
          module: options.diagnostics.module ?? "network",
          event: options.diagnostics.event ?? "network_fetch_start",
          message: "Network fetch started",
          provider: options.diagnostics.provider,
          model: options.diagnostics.model,
          sessionKey: options.diagnostics.sessionKey,
          projectKey: options.diagnostics.projectKey,
          runId: options.diagnostics.runId,
          turnId: options.diagnostics.turnId,
          attempt: attempt + 1,
          metadata: {
            url: sanitizeUrlForDiagnostics(resolveInputUrl(input)),
            method,
            timeoutMs: options.timeoutMs,
            maxRetries,
            ...options.diagnostics.metadata,
          },
        });
      }
      const response = await performFetch(input, {
        ...init,
        signal: controller.signal,
      }, options.fetchImpl);

      if (
        canRetryMethod &&
        attempt < maxRetries &&
        shouldRetryStatus(response.status, retry.retryStatuses)
      ) {
        logNetworkFetchStatusRetry(options, input, method, response.status, attempt, maxRetries, startedAt);
        void response.body?.cancel().catch(() => undefined);
        await delay(resolveRetryDelay(attempt, retry, response.headers.get("retry-after")), parentSignal);
        continue;
      }

      logNetworkFetchSuccess(options, input, method, response.status, attempt, maxRetries, startedAt);
      return response;
    } catch (error) {
      lastError = error;
      const normalized = normalizeNetworkError(error, controller.signal, parentSignal);
      logNetworkFetchError(options, input, method, normalized, error, attempt, maxRetries, startedAt);
      if (!canRetryMethod || attempt >= maxRetries || !isRetryableNetworkCode(normalized.code)) {
        throw normalized;
      }
      await delay(resolveRetryDelay(attempt, retry), parentSignal);
    } finally {
      if (timeout) clearTimeout(timeout);
      detachAbort?.();
    }
  }

  throw normalizeNetworkError(lastError);
}

export async function networkFetchJson<T = unknown>(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkJsonOptions = {},
): Promise<{ response: Response; json: T; text: string }> {
  const response = await networkFetch(input, init, options);
  const text = await response.text();
  const okStatus = options.expectedStatuses?.includes(response.status) ?? response.ok;
  if (!okStatus) {
    throw new NetworkFetchError(
      response.status === 429 ? "network_rate_limited" : response.status >= 500 ? "network_server_error" : "network_fetch_failed",
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      { status: response.status, statusText: response.statusText, body: text },
    );
  }
  try {
    return { response, json: JSON.parse(text) as T, text };
  } catch (error) {
    throw new NetworkFetchError("network_fetch_failed", `Non-JSON response from ${String(input)}: ${text.slice(0, 500)}`, error);
  }
}

export function networkPostJson<T = unknown>(
  input: string | URL | Request,
  body: unknown,
  init: RequestInit = {},
  options: NetworkJsonOptions = {},
): Promise<{ response: Response; json: T; text: string }> {
  return networkFetchJson<T>(input, {
    ...init,
    method: "POST",
    headers: withJsonContentType(init.headers),
    body: JSON.stringify(body),
  }, {
    ...options,
    retry: { retryOnPost: true, ...options.retry },
  });
}

export function normalizeNetworkError(
  error: unknown,
  localSignal?: AbortSignal,
  parentSignal?: AbortSignal,
): NetworkFetchError {
  if (error instanceof NetworkFetchError) return error;
  if (parentSignal?.aborted) {
    if (parentSignal.reason instanceof NetworkFetchError) return parentSignal.reason;
    return new NetworkFetchError("network_abort", "Network request aborted by parent signal.", parentSignal.reason);
  }
  if (localSignal?.aborted) {
    const reason = localSignal.reason;
    if (reason instanceof NetworkFetchError) return reason;
    return new NetworkFetchError("network_timeout", "Network request timed out.", reason);
  }

  const message = error instanceof Error ? error.message : String(error ?? "Network request failed.");
  const code = readErrorCode(error);
  const combined = `${code ?? ""} ${message}`.toLowerCase();

  if (combined.includes("enotfound") || combined.includes("eai_again") || combined.includes("dns")) {
    return new NetworkFetchError("network_dns_error", message, error);
  }
  if (combined.includes("econnreset") || combined.includes("socket hang up") || combined.includes("terminated")) {
    return new NetworkFetchError("network_connection_reset", message, error);
  }
  if (combined.includes("econnrefused")) {
    return new NetworkFetchError("network_connection_refused", message, error);
  }
  if (combined.includes("etimedout") || combined.includes("timeout")) {
    return new NetworkFetchError("network_timeout", message, error);
  }
  if (combined.includes("certificate") || combined.includes("tls") || combined.includes("ssl")) {
    return new NetworkFetchError("network_tls_error", message, error);
  }
  if (combined.includes("proxy")) {
    return new NetworkFetchError("network_proxy_error", message, error);
  }
  if (combined.includes("abort")) {
    return new NetworkFetchError("network_abort", message, error);
  }
  return new NetworkFetchError("network_fetch_failed", message, error);
}

export function isRetryableNetworkCode(code: NetworkErrorCode): boolean {
  return code !== "network_abort" && code !== "network_tls_error";
}

export function jitteredBackoff(attempt: number, retry: NetworkRetryOptions = {}, retryAfterHeader?: string | null): number {
  return resolveRetryDelay(attempt, retry, retryAfterHeader);
}

function performFetch(input: string | URL | Request, init: RequestInit, fetchImpl?: typeof fetch): Promise<Response> {
  if (fetchImpl) {
    return fetchImpl(input as Parameters<typeof fetch>[0], init);
  }
  // Proxy, NO_PROXY, keepalive and long transport timeouts are intentionally
  // owned by src/cli/proxy.ts and ui/server/utils/proxy.js via undici's global
  // dispatcher. Do not pass a per-request dispatcher here, or config hot-reload
  // of proxy.url/proxy.noProxy would be bypassed.
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

function logNetworkFetchSuccess(
  options: NetworkFetchOptions,
  input: string | URL | Request,
  method: string,
  status: number,
  attempt: number,
  maxRetries: number,
  startedAt: number,
): void {
  if (!options.diagnostics || !getDiagnosticLogger().config.networkDiagnostics) return;
  getDiagnosticLogger().debug({
    module: options.diagnostics.module ?? "network",
    event: "network_fetch_success",
    message: "Network fetch succeeded",
    provider: options.diagnostics.provider,
    model: options.diagnostics.model,
    sessionKey: options.diagnostics.sessionKey,
    projectKey: options.diagnostics.projectKey,
    runId: options.diagnostics.runId,
    turnId: options.diagnostics.turnId,
    attempt: attempt + 1,
    durationMs: Date.now() - startedAt,
    metadata: {
      url: sanitizeUrlForDiagnostics(resolveInputUrl(input)),
      method,
      status,
      maxRetries,
      ...options.diagnostics.metadata,
    },
  });
}

function logNetworkFetchStatusRetry(
  options: NetworkFetchOptions,
  input: string | URL | Request,
  method: string,
  status: number,
  attempt: number,
  maxRetries: number,
  startedAt: number,
): void {
  if (!options.diagnostics || !getDiagnosticLogger().config.networkDiagnostics) return;
  getDiagnosticLogger().debug({
    module: options.diagnostics.module ?? "network",
    event: "network_fetch_status_retry",
    message: "Network fetch status is retryable",
    provider: options.diagnostics.provider,
    model: options.diagnostics.model,
    sessionKey: options.diagnostics.sessionKey,
    projectKey: options.diagnostics.projectKey,
    runId: options.diagnostics.runId,
    turnId: options.diagnostics.turnId,
    attempt: attempt + 1,
    durationMs: Date.now() - startedAt,
    metadata: {
      url: sanitizeUrlForDiagnostics(resolveInputUrl(input)),
      method,
      status,
      maxRetries,
      ...options.diagnostics.metadata,
    },
  });
}

function logNetworkFetchError(
  options: NetworkFetchOptions,
  input: string | URL | Request,
  method: string,
  normalized: NetworkFetchError,
  rawError: unknown,
  attempt: number,
  maxRetries: number,
  startedAt: number,
): void {
  if (!options.diagnostics || !getDiagnosticLogger().config.networkDiagnostics) return;
  getDiagnosticLogger().debug({
    module: options.diagnostics.module ?? "network",
    event: "network_fetch_error",
    message: normalized.message,
    provider: options.diagnostics.provider,
    model: options.diagnostics.model,
    sessionKey: options.diagnostics.sessionKey,
    projectKey: options.diagnostics.projectKey,
    runId: options.diagnostics.runId,
    turnId: options.diagnostics.turnId,
    attempt: attempt + 1,
    durationMs: Date.now() - startedAt,
    error: normalized,
    cause: serializeErrorForDiagnostics(rawError),
    metadata: {
      url: sanitizeUrlForDiagnostics(resolveInputUrl(input)),
      method,
      code: normalized.code,
      timeoutSource: normalized.code === "network_timeout" ? "network_fetch_timeout" : undefined,
      retryable: isRetryableNetworkCode(normalized.code),
      willRetry: attempt < maxRetries && isRetryableNetworkCode(normalized.code),
      maxRetries,
      ...options.diagnostics.metadata,
    },
  });
}

function resolveInputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function shouldRetryStatus(status: number, configured?: readonly number[]): boolean {
  if (configured) return configured.includes(status);
  return DEFAULT_RETRY_STATUSES.has(status);
}

function resolveRetryDelay(attempt: number, retry: NetworkRetryOptions, retryAfterHeader?: string | null): number {
  const retryAfter = parseRetryAfterHeader(retryAfterHeader);
  const cap = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (retryAfter !== undefined) return Math.min(cap, retryAfter);
  const base = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const exponential = Math.min(cap, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
  return Math.min(cap, exponential + jitter);
}

function parseRetryAfterHeader(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  if (signal.aborted) return Promise.reject(new NetworkFetchError("network_abort", "Network retry aborted.", signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NetworkFetchError("network_abort", "Network retry aborted.", signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function resolveMethod(input: string | URL | Request, init: RequestInit): string {
  const method = init.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybe = error as { code?: unknown; cause?: unknown };
  if (typeof maybe.code === "string") return maybe.code;
  if (maybe.cause && typeof maybe.cause === "object") {
    const causeCode = (maybe.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

function withJsonContentType(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}
