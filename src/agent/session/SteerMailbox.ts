import type { CanonicalMessage } from "../../model/index.js";

export type AgentSteerMessage = {
  itemId: string;
  message: CanonicalMessage;
  allowedReadFiles?: string[];
};

export type AgentSteerResult = {
  accepted: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "turn_closing";
};

/**
 * Turn-scoped inbox for user guidance submitted while an agent is running.
 *
 * `drainOrClose` is deliberately synchronous: JavaScript cannot interleave an
 * enqueue between observing an empty inbox and closing it, which removes the
 * terminal-turn race where accepted guidance could otherwise be lost.
 */
export class SteerMailbox {
  private turnId: string | undefined;
  private open = false;
  private readonly pending: AgentSteerMessage[] = [];
  private readonly seenItemIds = new Set<string>();

  start(turnId: string): void {
    this.turnId = turnId;
    this.open = true;
    this.pending.splice(0);
    this.seenItemIds.clear();
  }

  enqueue(turnId: string, input: AgentSteerMessage): AgentSteerResult {
    if (!this.turnId) return { accepted: false, reason: "no_active_turn" };
    if (this.turnId !== turnId) return { accepted: false, reason: "turn_mismatch" };
    if (!this.open) return { accepted: false, reason: "turn_closing" };
    if (this.seenItemIds.has(input.itemId)) return { accepted: true };
    this.seenItemIds.add(input.itemId);
    this.pending.push(input);
    return { accepted: true };
  }

  drain(turnId: string): AgentSteerMessage[] {
    if (!this.open || this.turnId !== turnId) return [];
    return this.pending.splice(0);
  }

  drainOrClose(turnId: string): { messages: AgentSteerMessage[]; closed: boolean } {
    if (!this.open || this.turnId !== turnId) return { messages: [], closed: true };
    if (this.pending.length > 0) {
      return { messages: this.pending.splice(0), closed: false };
    }
    this.open = false;
    return { messages: [], closed: true };
  }

  finish(turnId: string): AgentSteerMessage[] {
    if (this.turnId !== turnId) return [];
    this.open = false;
    this.turnId = undefined;
    const remaining = this.pending.splice(0);
    this.seenItemIds.clear();
    return remaining;
  }
}
