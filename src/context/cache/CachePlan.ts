import type { CachePlan, CanonicalMessage, CanonicalToolSchema } from "../../model/index.js";
export type { CachePlan } from "../../model/index.js";

export type CachePlanInput = {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools: CanonicalToolSchema[];
  messages: CanonicalMessage[];
  enabled: boolean;
};

export const RECENT_MESSAGE_BREAKPOINT_COUNT = 3;

/** Select the final non-system messages for the Anthropic recent-message layout. */
export function selectRecentMessageBreakpoints(messages: CanonicalMessage[]): number[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => (message as { role: string }).role !== "system")
    .slice(-RECENT_MESSAGE_BREAKPOINT_COUNT)
    .map(({ index }) => index);
}

/** Stable, non-cryptographic serialization for cache-plan identity. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function buildCachePlan(input: CachePlanInput, generation: number): CachePlan | undefined {
  if (!input.enabled) return undefined;
  const messages = selectRecentMessageBreakpoints(input.messages);
  const stableTools = [...input.tools].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : stableSerialize(left).localeCompare(stableSerialize(right));
  });
  return {
    provider: input.provider,
    model: input.model,
    system: Boolean(input.systemPrompt),
    tools: false,
    messages,
    fingerprint: stableSerialize({
      provider: input.provider ?? "",
      model: input.model ?? "",
      system: input.systemPrompt ?? "",
      tools: stableTools,
      messages: messages.map((index) => input.messages[index]),
    }),
    generation,
  };
}
