import type { GatewayEvent } from "../../../gateway/index.js";

export function pickFirstError(events: GatewayEvent[]): { code?: string; message: string } | undefined {
  for (const event of events) {
    if (event.type === "error") {
      return { code: event.code, message: event.message };
    }
  }
  return undefined;
}

export function extractAssistantText(events: GatewayEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "assistant_text_delta") {
      text += event.text;
    }
  }
  return text.trim();
}
