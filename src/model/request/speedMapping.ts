import type { SpeedMapping } from "../protocol/canonical.js";

export type OpenAISpeedTier = "priority";
export type AnthropicSpeed = "standard" | "fast";

/** Normalize the shared 0..1 preference to the provider's discrete tiers. */
export function mapSpeedToOpenAIServiceTier(speed: number): OpenAISpeedTier | undefined {
  if (speed >= 0.5) return "priority";
  return undefined;
}

export function mapSpeedToAnthropicSpeed(speed: number): AnthropicSpeed {
  return speed >= 0.5 ? "fast" : "standard";
}

export function hasSpeedMapping(mapping: SpeedMapping | undefined, expected: SpeedMapping): boolean {
  return mapping === expected;
}
