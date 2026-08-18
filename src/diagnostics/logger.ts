import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { inspect } from "node:util";
import { resolvePilotHome } from "../pilot/paths.js";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticLoggingConfig = {
  enabled: boolean;
  level: DiagnosticLogLevel;
  networkDiagnostics: boolean;
  file: {
    enabled: boolean;
    level: DiagnosticLogLevel;
    dir: string;
    maxSizeMb: number;
    maxFiles: number;
  };
};

export type DiagnosticLogEntry = {
  timestamp?: string;
  level?: DiagnosticLogLevel;
  module: string;
  event: string;
  message?: string;
  sessionKey?: string;
  projectKey?: string;
  runId?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  durationMs?: number;
  error?: unknown;
  cause?: unknown;
  metadata?: Record<string, unknown>;
};

export type DiagnosticLogger = {
  debug(entry: Omit<DiagnosticLogEntry, "level" | "timestamp">): void;
  info(entry: Omit<DiagnosticLogEntry, "level" | "timestamp">): void;
  warn(entry: Omit<DiagnosticLogEntry, "level" | "timestamp">): void;
  error(entry: Omit<DiagnosticLogEntry, "level" | "timestamp">): void;
  child(defaults: Partial<Omit<DiagnosticLogEntry, "level" | "timestamp">>): DiagnosticLogger;
  readonly config: DiagnosticLoggingConfig;
};

export const DIAGNOSTIC_LOG_LEVELS: DiagnosticLogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_RANK: Record<DiagnosticLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_SIZE_MB = 20;
const DEFAULT_MAX_FILES = 14;
const MAX_STRING_LENGTH = 2_000;
const SECRET_KEY_RE = /(api[_-]?key|authorization|cookie|token|secret|password|auth[_-]?token|access[_-]?token|bearer)$/i;

export function defaultDiagnosticLoggingConfig(env: Record<string, string | undefined> = process.env): DiagnosticLoggingConfig {
  const pilotHome = resolvePilotHome(env);
  return {
    enabled: true,
    level: "info",
    networkDiagnostics: true,
    file: {
      enabled: true,
      level: "debug",
      dir: join(pilotHome, "logs"),
      maxSizeMb: DEFAULT_MAX_SIZE_MB,
      maxFiles: DEFAULT_MAX_FILES,
    },
  };
}

export function applyDiagnosticLoggingEnv(
  config: DiagnosticLoggingConfig,
  env: Record<string, string | undefined> = process.env,
): DiagnosticLoggingConfig {
  const level = parseLevel(env.PILOTDECK_LOG_LEVEL) ?? config.level;
  const dir = env.PILOTDECK_LOG_DIR?.trim() ? resolve(env.PILOTDECK_LOG_DIR.trim()) : config.file.dir;
  const fileEnabled = parseBoolean(env.PILOTDECK_LOG_FILE_ENABLED) ?? config.file.enabled;
  const networkDiagnostics = parseBoolean(env.PILOTDECK_NETWORK_DIAGNOSTICS) ?? config.networkDiagnostics;
  return {
    ...config,
    level,
    networkDiagnostics,
    file: {
      ...config.file,
      enabled: fileEnabled,
      dir,
    },
  };
}

export function createDiagnosticLogger(
  processName: string,
  config: DiagnosticLoggingConfig = defaultDiagnosticLoggingConfig(),
  defaults: Partial<Omit<DiagnosticLogEntry, "level" | "timestamp">> = {},
): DiagnosticLogger {
  const safeProcessName = sanitizeFileComponent(processName || "pilotdeck");
  const filePath = join(config.file.dir, `${safeProcessName}.jsonl`);

  const write = (level: DiagnosticLogLevel, entry: Omit<DiagnosticLogEntry, "level" | "timestamp">) => {
    if (!config.enabled) return;
    const merged = sanitizeLogValue({
      timestamp: new Date().toISOString(),
      level,
      ...defaults,
      ...entry,
      error: entry.error !== undefined ? serializeErrorForDiagnostics(entry.error) : undefined,
      cause: entry.cause !== undefined ? serializeErrorForDiagnostics(entry.cause) : undefined,
    }) as DiagnosticLogEntry;

    if (LEVEL_RANK[level] >= LEVEL_RANK[config.level]) {
      writeConsole(merged);
    }
    if (config.file.enabled && LEVEL_RANK[level] >= LEVEL_RANK[config.file.level]) {
      appendJsonl(filePath, merged, config.file.maxSizeMb, config.file.maxFiles);
    }
  };

  return {
    get config() {
      return config;
    },
    debug(entry) {
      write("debug", entry);
    },
    info(entry) {
      write("info", entry);
    },
    warn(entry) {
      write("warn", entry);
    },
    error(entry) {
      write("error", entry);
    },
    child(childDefaults) {
      return createDiagnosticLogger(safeProcessName, config, { ...defaults, ...childDefaults });
    },
  };
}

let globalDiagnosticLogger: DiagnosticLogger = createDiagnosticLogger(
  "gateway",
  applyDiagnosticLoggingEnv(defaultDiagnosticLoggingConfig()),
);

export function configureGlobalDiagnosticLogger(config: DiagnosticLoggingConfig, processName = "gateway"): DiagnosticLogger {
  globalDiagnosticLogger = createDiagnosticLogger(processName, applyDiagnosticLoggingEnv(config));
  return globalDiagnosticLogger;
}

export function getDiagnosticLogger(): DiagnosticLogger {
  return globalDiagnosticLogger;
}

export function parseLevel(value: unknown): DiagnosticLogLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return DIAGNOSTIC_LOG_LEVELS.includes(normalized as DiagnosticLogLevel)
    ? normalized as DiagnosticLogLevel
    : undefined;
}

export function serializeErrorForDiagnostics(error: unknown, depth = 0): Record<string, unknown> | string | undefined {
  if (error === undefined || error === null) return undefined;
  if (depth > 5) return "[cause chain truncated]";
  if (error instanceof Error) {
    const record: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    const errRecord = error as Error & Record<string, unknown>;
    for (const key of ["code", "errno", "syscall", "address", "port", "status", "statusCode"]) {
      if (errRecord[key] !== undefined) record[key] = errRecord[key];
    }
    if (errRecord.cause !== undefined) {
      record.cause = serializeErrorForDiagnostics(errRecord.cause, depth + 1);
    }
    return sanitizeLogValue(record) as Record<string, unknown>;
  }
  if (typeof error === "object") {
    return sanitizeLogValue(error) as Record<string, unknown>;
  }
  return truncateString(String(error));
}

export function sanitizeUrlForDiagnostics(value: string | URL | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return truncateString(String(value));
  }
}

export function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (value === undefined) return undefined;
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value instanceof URL) return sanitizeUrlForDiagnostics(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childValue === undefined) continue;
      output[childKey] = sanitizeLogValue(childValue, childKey);
    }
    return output;
  }
  return truncateString(String(value));
}

function appendJsonl(filePath: string, entry: DiagnosticLogEntry, maxSizeMb: number, maxFiles: number): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    rotateIfNeeded(filePath, maxSizeMb, maxFiles);
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Diagnostics must never affect the agent runtime.
  }
}

function rotateIfNeeded(filePath: string, maxSizeMb: number, maxFiles: number): void {
  const maxBytes = Math.max(1, maxSizeMb) * 1024 * 1024;
  if (!existsSync(filePath) || statSync(filePath).size < maxBytes) return;
  const dir = dirname(filePath);
  const stem = basename(filePath, ".jsonl");
  const rotated = join(dir, `${stem}.${new Date().toISOString().slice(0, 10)}.${Date.now()}.jsonl`);
  renameSync(filePath, rotated);
  const files = readdirSync(dir)
    .filter((name) => name === `${stem}.jsonl` || (name.startsWith(`${stem}.`) && name.endsWith(".jsonl")))
    .map((name) => ({ name, path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(Math.max(1, maxFiles))) {
    try {
      unlinkSync(file.path);
    } catch {
      // best effort
    }
  }
}

function writeConsole(entry: DiagnosticLogEntry): void {
  const line = `[pilotdeck:${entry.module}] ${entry.event}${entry.message ? ` - ${entry.message}` : ""}`;
  const metadata = {
    sessionKey: entry.sessionKey,
    projectKey: entry.projectKey,
    runId: entry.runId,
    turnId: entry.turnId,
    provider: entry.provider,
    model: entry.model,
    attempt: entry.attempt,
    durationMs: entry.durationMs,
  };
  const compact = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
  const suffix = Object.keys(compact).length > 0 ? ` ${inspect(compact, { colors: false, breakLength: 120 })}` : "";
  if (entry.level === "error") console.error(`${line}${suffix}`);
  else if (entry.level === "warn") console.warn(`${line}${suffix}`);
  else console.log(`${line}${suffix}`);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]` : value;
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pilotdeck";
}
