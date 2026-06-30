import type { Gateway, GatewayEvent } from "../../../gateway/index.js";
import type { AgentTurnInput } from "./types.js";

export type AgentTurnRunnerDeps = {
  gateway: Gateway;
  projectKey: string;
  onTurnEvent?: (sessionKey: string, channelKey: string, event: GatewayEvent) => void;
};

export class AgentTurnRunner {
  constructor(private readonly deps: AgentTurnRunnerDeps) {}

  async run(input: AgentTurnInput): Promise<GatewayEvent[]> {
    const events: GatewayEvent[] = [];
    for await (const event of this.deps.gateway.submitTurn({
      sessionKey: input.sessionKey,
      channelKey: input.channelKey,
      message: input.message,
      mode: input.mode,
      runId: input.runId,
      projectKey: this.deps.projectKey,
      telemetry: {
        ownerModule: "always_on",
        executionKind: "always_on",
        phase: String(input.channelKey).startsWith("always-on/")
          ? String(input.channelKey).slice("always-on/".length)
          : undefined,
      },
    })) {
      events.push(event);
      this.deps.onTurnEvent?.(input.sessionKey, input.channelKey, event);
    }
    return events;
  }

  async closeSession(sessionKey: string): Promise<void> {
    await this.deps.gateway
      .closeSession({ sessionKey, reason: "always-on/done" })
      .catch(() => undefined);
  }
}
