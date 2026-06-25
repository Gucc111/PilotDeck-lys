import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { PreferenceEventStore } from "../storage/PreferenceEventStore.js";
import {
  buildConsolidationSystemPrompt,
  buildConsolidationUserPrompt,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
} from "./preferencePrompts.js";

export type PreferenceLlmOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  protocol?: "openai" | "anthropic";
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type PreferenceExtractionInput = {
  preferencesFile: string;
  eventStore: PreferenceEventStore;
  llm: PreferenceLlmOptions;
  consolidationThreshold: number;
  language?: string;
};

export type PreferenceExtractionResult = {
  extracted: boolean;
  consolidated: boolean;
  newEventsCount: number;
  dimensionCount: number;
};

export type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type PreferenceExtractorDependencies = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type PreparePreferenceMemoryInput = {
  enabled: boolean;
  extractionThreshold: number;
  consolidationThreshold: number;
  preferencesFile: string;
  eventStore?: PreferenceEventStore;
  llm?: PreferenceLlmOptions;
  language?: string;
  logger?: LoggerLike;
  extractor?: PreferenceExtractor;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const preferenceFileQueues = new Map<string, Promise<void>>();

export class PreferenceExtractor {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly logger?: LoggerLike,
    dependencies: PreferenceExtractorDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async extract(input: PreferenceExtractionInput): Promise<PreferenceExtractionResult> {
    const unindexed = await input.eventStore.readUnindexedEvents();
    if (unindexed.length === 0) {
      return { extracted: false, consolidated: false, newEventsCount: 0, dimensionCount: 0 };
    }

    const existing = await readPreferences(input.preferencesFile);
    let llmOutput: string;
    try {
      llmOutput = await this.callLlm(
        input.llm,
        buildExtractionSystemPrompt(input.language),
        buildExtractionUserPrompt(existing, unindexed, input.language),
      );
    } catch (error) {
      this.logger?.warn?.("[always-on/memory] preference extraction LLM call failed", error);
      return {
        extracted: false,
        consolidated: false,
        newEventsCount: unindexed.length,
        dimensionCount: 0,
      };
    }

    const trimmed = llmOutput.trim();
    if (trimmed === "NONE" || trimmed === "") {
      await input.eventStore.markIndexed(unindexed.map((event) => event.eventId));
      return {
        extracted: true,
        consolidated: false,
        newEventsCount: unindexed.length,
        dimensionCount: countDimensions(existing),
      };
    }

    await writePreferences(input.preferencesFile, trimmed);
    await input.eventStore.markIndexed(unindexed.map((event) => event.eventId));

    const dimensionCount = countDimensions(trimmed);
    const consolidated = dimensionCount > input.consolidationThreshold
      ? await this.consolidate(input)
      : false;

    return { extracted: true, consolidated, newEventsCount: unindexed.length, dimensionCount };
  }

  async consolidate(input: PreferenceExtractionInput): Promise<boolean> {
    const existing = await readPreferences(input.preferencesFile);
    if (!existing.trim()) return false;

    let llmOutput: string;
    try {
      llmOutput = await this.callLlm(
        input.llm,
        buildConsolidationSystemPrompt(input.language),
        buildConsolidationUserPrompt(existing, input.language),
      );
    } catch (error) {
      this.logger?.warn?.("[always-on/memory] preference consolidation LLM call failed", error);
      return false;
    }

    const trimmed = llmOutput.trim();
    if (!trimmed) return false;
    await writePreferences(input.preferencesFile, trimmed);
    return true;
  }

  private async callLlm(
    options: PreferenceLlmOptions,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const isAnthropic = options.protocol === "anthropic";
    const base = options.baseUrl.replace(/\/+$/, "");
    const url = isAnthropic
      ? `${base}${/\/v1$/.test(base) ? "" : "/v1"}/messages`
      : `${base}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...options.headers,
    };
    if (isAnthropic) {
      headers["x-api-key"] = options.apiKey.trim();
      headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    } else {
      headers.authorization = `Bearer ${options.apiKey.trim()}`;
    }

    const body = isAnthropic
      ? {
          model: options.model,
          temperature: 0,
          stream: false,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }
      : {
          model: options.model,
          temperature: 0,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        };

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown = new Error("Preference LLM request failed");

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let retryable = false;
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = await response.json() as Record<string, unknown>;
          return isAnthropic
            ? extractAnthropicText(payload)
            : extractOpenAiText(payload);
        }

        const errorText = await response.text().catch(() => "");
        lastError = new Error(`LLM request failed (${response.status}): ${errorText.slice(0, 300)}`);
        retryable = RETRYABLE_STATUS_CODES.has(response.status);
        if (!retryable) throw lastError;
      } catch (error) {
        lastError = error instanceof Error && error.name === "AbortError"
          ? new Error(`LLM request timed out after ${timeoutMs}ms`)
          : error;
        retryable = retryable || isRetryableNetworkError(lastError);
        if (!retryable) throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }

      if (attempt < MAX_RETRIES) {
        await this.sleep(1000 * (attempt + 1));
      }
    }

    throw lastError;
  }
}

export async function preparePreferenceMemory(
  input: PreparePreferenceMemoryInput,
): Promise<string | undefined> {
  if (!input.enabled) return undefined;

  if (input.eventStore && input.llm) {
    try {
      const unindexedCount = await input.eventStore.countUnindexed();
      if (unindexedCount >= input.extractionThreshold) {
        await (input.extractor ?? new PreferenceExtractor(input.logger)).extract({
          preferencesFile: input.preferencesFile,
          eventStore: input.eventStore,
          llm: input.llm,
          consolidationThreshold: input.consolidationThreshold,
          language: input.language,
        });
      }
    } catch (error) {
      input.logger?.warn?.("[always-on/memory] preference extraction preparation failed", error);
    }
  }

  try {
    const preferences = await readPreferences(input.preferencesFile);
    return preferences.trim() ? preferences : undefined;
  } catch (error) {
    input.logger?.warn?.("[always-on/memory] failed to read preferences", error);
    return undefined;
  }
}

export async function readPreferences(filePath: string): Promise<string> {
  return withPreferenceFileQueue(filePath, async () => {
    try {
      return await readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  });
}

async function writePreferences(filePath: string, content: string): Promise<void> {
  await withPreferenceFileQueue(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  });
}

function countDimensions(content: string): number {
  return (content.match(/^###\s+/gm) ?? []).length;
}

function extractOpenAiText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

function extractAnthropicText(payload: Record<string, unknown>): string {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return "";
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof Error &&
    /timeout|timed out|abort|econnreset|econnrefused|fetch failed|network/i.test(error.message);
}

function withPreferenceFileQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = preferenceFileQueues.get(filePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  preferenceFileQueues.set(filePath, tail);
  return result.finally(() => {
    if (preferenceFileQueues.get(filePath) === tail) preferenceFileQueues.delete(filePath);
  });
}
