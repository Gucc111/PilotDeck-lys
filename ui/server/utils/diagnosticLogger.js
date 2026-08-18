import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { parse as parseYaml } from 'yaml';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING_LENGTH = 2000;
const SECRET_KEY_RE = /(api[_-]?key|authorization|cookie|token|secret|password|auth[_-]?token|access[_-]?token|bearer)$/i;

function pilotHome(env = process.env) {
    const value = env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.resolve(os.homedir(), value.slice(2));
    return path.resolve(value);
}

function parseLevel(value, fallback) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return LEVELS.includes(normalized) ? normalized : fallback;
}

function parseBoolean(value, fallback) {
    if (value === undefined) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function configFromEnv(env = process.env) {
    const base = mergeLoggingConfig({
        enabled: true,
        level: 'info',
        networkDiagnostics: true,
        file: {
            enabled: true,
            level: 'debug',
            dir: path.join(pilotHome(env), 'logs'),
            maxSizeMb: 20,
            maxFiles: 14,
        },
    }, readYamlLoggingConfig(env));
    return {
        ...base,
        level: parseLevel(env.PILOTDECK_LOG_LEVEL, base.level),
        networkDiagnostics: parseBoolean(env.PILOTDECK_NETWORK_DIAGNOSTICS, base.networkDiagnostics),
        file: {
            ...base.file,
            enabled: parseBoolean(env.PILOTDECK_LOG_FILE_ENABLED, base.file.enabled),
            dir: env.PILOTDECK_LOG_DIR?.trim() ? path.resolve(env.PILOTDECK_LOG_DIR.trim()) : base.file.dir,
        },
    };
}

function readYamlLoggingConfig(env) {
    try {
        const configPath = path.join(pilotHome(env), 'pilotdeck.yaml');
        if (!fs.existsSync(configPath)) return null;
        const parsed = parseYaml(fs.readFileSync(configPath, 'utf8'));
        return parsed?.logging && typeof parsed.logging === 'object' ? parsed.logging : null;
    } catch {
        return null;
    }
}

function mergeLoggingConfig(base, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const file = raw.file && typeof raw.file === 'object' && !Array.isArray(raw.file) ? raw.file : {};
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        level: parseLevel(raw.level, base.level),
        networkDiagnostics: typeof raw.networkDiagnostics === 'boolean' ? raw.networkDiagnostics : base.networkDiagnostics,
        file: {
            enabled: typeof file.enabled === 'boolean' ? file.enabled : base.file.enabled,
            level: parseLevel(file.level, base.file.level),
            dir: typeof file.dir === 'string' && file.dir.trim() ? path.resolve(file.dir.trim()) : base.file.dir,
            maxSizeMb: Number.isInteger(file.maxSizeMb) && file.maxSizeMb > 0 ? file.maxSizeMb : base.file.maxSizeMb,
            maxFiles: Number.isInteger(file.maxFiles) && file.maxFiles > 0 ? file.maxFiles : base.file.maxFiles,
        },
    };
}

export function createDiagnosticLogger(processName, config = configFromEnv()) {
    const filePath = path.join(config.file.dir, `${sanitizeFileComponent(processName)}.jsonl`);
    const write = (level, entry) => {
        if (!config.enabled) return;
        const normalized = sanitizeLogValue({
            timestamp: new Date().toISOString(),
            level,
            ...entry,
            error: entry.error !== undefined ? serializeErrorForDiagnostics(entry.error) : undefined,
            cause: entry.cause !== undefined ? serializeErrorForDiagnostics(entry.cause) : undefined,
        });
        if (LEVEL_RANK[level] >= LEVEL_RANK[config.level]) writeConsole(normalized);
        if (config.file.enabled && LEVEL_RANK[level] >= LEVEL_RANK[config.file.level]) appendJsonl(filePath, normalized, config.file.maxSizeMb, config.file.maxFiles);
    };
    return {
        config,
        debug: (entry) => write('debug', entry),
        info: (entry) => write('info', entry),
        warn: (entry) => write('warn', entry),
        error: (entry) => write('error', entry),
    };
}

export const uiDiagnosticLogger = createDiagnosticLogger('ui-server');

export function serializeErrorForDiagnostics(error, depth = 0) {
    if (error === undefined || error === null) return undefined;
    if (depth > 5) return '[cause chain truncated]';
    if (error instanceof Error) {
        const record = { name: error.name, message: error.message };
        for (const key of ['code', 'errno', 'syscall', 'address', 'port', 'status', 'statusCode']) {
            if (error[key] !== undefined) record[key] = error[key];
        }
        if (error.cause !== undefined) record.cause = serializeErrorForDiagnostics(error.cause, depth + 1);
        return sanitizeLogValue(record);
    }
    if (typeof error === 'object') return sanitizeLogValue(error);
    return truncateString(String(error));
}

export function sanitizeUrlForDiagnostics(value) {
    if (!value) return undefined;
    try {
        const url = new URL(String(value));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return truncateString(String(value));
    }
}

function sanitizeLogValue(value, key = '') {
    if (value === undefined) return undefined;
    if (SECRET_KEY_RE.test(key)) return '[redacted]';
    if (typeof value === 'string') return truncateString(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (value instanceof URL) return sanitizeUrlForDiagnostics(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item));
    if (typeof value === 'object') {
        const output = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            if (childValue === undefined) continue;
            output[childKey] = sanitizeLogValue(childValue, childKey);
        }
        return output;
    }
    return truncateString(String(value));
}

function appendJsonl(filePath, entry, maxSizeMb, maxFiles) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        rotateIfNeeded(filePath, maxSizeMb, maxFiles);
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
        // Diagnostics must never affect the UI server.
    }
}

function rotateIfNeeded(filePath, maxSizeMb, maxFiles) {
    const maxBytes = Math.max(1, maxSizeMb) * 1024 * 1024;
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) return;
    const dir = path.dirname(filePath);
    const stem = path.basename(filePath, '.jsonl');
    fs.renameSync(filePath, path.join(dir, `${stem}.${new Date().toISOString().slice(0, 10)}.${Date.now()}.jsonl`));
    const files = fs.readdirSync(dir)
        .filter((name) => name === `${stem}.jsonl` || (name.startsWith(`${stem}.`) && name.endsWith('.jsonl')))
        .map((name) => ({ path: path.join(dir, name), mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(Math.max(1, maxFiles))) {
        try { fs.unlinkSync(file.path); } catch { /* best effort */ }
    }
}

function writeConsole(entry) {
    const line = `[pilotdeck:${entry.module}] ${entry.event}${entry.message ? ` - ${entry.message}` : ''}`;
    const compact = {};
    for (const key of ['sessionKey', 'projectKey', 'runId', 'turnId', 'provider', 'model', 'attempt', 'durationMs']) {
        if (entry[key] !== undefined) compact[key] = entry[key];
    }
    const suffix = Object.keys(compact).length > 0 ? ` ${util.inspect(compact, { colors: false, breakLength: 120 })}` : '';
    if (entry.level === 'error') console.error(`${line}${suffix}`);
    else if (entry.level === 'warn') console.warn(`${line}${suffix}`);
    else console.log(`${line}${suffix}`);
}

function truncateString(value) {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]` : value;
}

function sanitizeFileComponent(value) {
    return String(value || 'pilotdeck').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pilotdeck';
}
