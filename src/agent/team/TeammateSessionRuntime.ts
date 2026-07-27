import type {
  PilotDeckTeamControlDecisionAction,
  PilotDeckTeamDelegateResult,
  PilotDeckTeamMessageKind,
  PilotDeckTeamPermissionSnapshot,
  PilotDeckTeamRuntimeApi,
} from "../../tool/protocol/types.js";
import { TeamControlCoordinator } from "./TeamControlCoordinator.js";
import { TeamMessageCoordinator } from "./TeamMessageCoordinator.js";
import { TeamProgressStore } from "./TeamProgressStore.js";
import { teammateSessionKey, type RuntimeTeammateDefinition } from "./types.js";

export type TeammateTurnHost = {
  run(input: {
    leaderSessionId: string;
    projectRoot: string;
    definition: RuntimeTeammateDefinition;
    action: "run" | "follow_up";
    prompt: string;
    taskId?: string;
    parentTurnId: string;
    toolCallId?: string;
    permission: PilotDeckTeamPermissionSnapshot;
    abortSignal?: AbortSignal;
  }): Promise<PilotDeckTeamDelegateResult>;
  shutdown(input: {
    leaderSessionId: string;
    projectRoot: string;
    definition: RuntimeTeammateDefinition;
  }): Promise<PilotDeckTeamDelegateResult>;
};

export type TeammateSessionRuntimeOptions = {
  leaderSessionId: string;
  projectRoot: string;
  progressPath: string;
  control: TeamControlCoordinator;
  messages: TeamMessageCoordinator;
  actorTeammateId?: string;
  definitions: () => RuntimeTeammateDefinition[];
  diagnostics?: () => string[];
  host: TeammateTurnHost;
  now?: () => Date;
};

export class TeammateSessionRuntime implements PilotDeckTeamRuntimeApi {
  private readonly progress: TeamProgressStore;
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: TeammateSessionRuntimeOptions) {
    this.progress = new TeamProgressStore({
      path: options.progressPath,
      now: options.now,
    });
  }

  listDefinitions() {
    return this.options.definitions().map((definition) => ({
      id: definition.id,
      description: definition.description,
      ...(definition.model ? { model: definition.model } : {}),
    }));
  }

  listDiagnostics(): string[] {
    return [...(this.options.diagnostics?.() ?? [])];
  }

  readProgress() {
    return this.progress.read();
  }

  updateProgress(input: Parameters<PilotDeckTeamRuntimeApi["updateProgress"]>[0]) {
    return this.progress.update(input);
  }

  listControlRequests(input?: Parameters<PilotDeckTeamRuntimeApi["listControlRequests"]>[0]) {
    return this.options.control.list(input);
  }

  readControlRequest(requestId: string) {
    return this.options.control.read(requestId);
  }

  controlRequest(input: {
    action: PilotDeckTeamControlDecisionAction | "escalate_to_user";
    requestId: string;
    feedback?: string;
  }) {
    if (input.action === "escalate_to_user") {
      return this.options.control.escalate(input.requestId, input.feedback);
    }
    return this.options.control.decide({
      requestId: input.requestId,
      action: input.action,
      feedback: input.feedback,
    });
  }

  async sendMessage(
    input: Parameters<PilotDeckTeamRuntimeApi["sendMessage"]>[0],
  ) {
    const text = input.message.trim();
    if (!text) throw new Error("Team message requires non-empty text.");
    const leader = {
      role: "leader" as const,
      id: "leader" as const,
      sessionId: this.options.leaderSessionId,
    };
    const actorTeammateId = this.options.actorTeammateId;
    if (actorTeammateId) {
      if (input.to !== "leader") {
        throw new Error('Teammates may only send Team messages to "leader".');
      }
      const from = {
        role: "teammate" as const,
        id: actorTeammateId,
        sessionId: teammateSessionKey(this.options.leaderSessionId, actorTeammateId),
      };
      const message = await this.options.messages.enqueue({
        from,
        to: leader,
        kind: "explicit",
        text,
        ...(input.summary ? { summary: input.summary } : {}),
      });
      return { messageId: message.id, from, to: leader, status: "queued" as const };
    }

    if (input.to === "leader") {
      throw new Error("The Team Leader cannot send a Team message to itself.");
    }
    const definition = this.options.definitions().find((entry) => entry.id === input.to);
    if (!definition) throw new Error(`Unknown Teammate "${input.to}".`);
    const from = leader;
    const to = {
      role: "teammate" as const,
      id: definition.id,
      sessionId: teammateSessionKey(this.options.leaderSessionId, definition.id),
    };
    const message = await this.options.messages.enqueue({
      from,
      to,
      kind: "explicit",
      text,
      ...(input.summary ? { summary: input.summary } : {}),
      permission: input.permission,
    });
    return { messageId: message.id, from, to, status: "queued" as const };
  }

  async delegate(
    input: Parameters<PilotDeckTeamRuntimeApi["delegate"]>[0],
  ): Promise<PilotDeckTeamDelegateResult> {
    const definition = this.options.definitions().find((entry) => entry.id === input.teammateId);
    if (!definition) {
      throw new Error(`Unknown Teammate "${input.teammateId}".`);
    }
    if (input.action === "shutdown") {
      return this.options.host.shutdown({
        leaderSessionId: this.options.leaderSessionId,
        projectRoot: this.options.projectRoot,
        definition,
      });
    }

    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new Error(`Teammate ${input.action} requires a prompt.`);
    }
    if (this.inFlight.has(definition.id)) {
      throw new Error(`Teammate "${definition.id}" is already running a turn.`);
    }
    if (input.taskId) {
      await this.progress.update({
        merge: true,
        items: [{
          id: input.taskId,
          content: prompt,
          status: "in_progress",
          teammateId: definition.id,
        }],
      });
    }
    this.inFlight.add(definition.id);
    void this.runInBackground(definition, input, input.action, prompt);
    return {
      teammateId: definition.id,
      teammateSessionId: teammateSessionKey(this.options.leaderSessionId, definition.id),
      action: input.action,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      status: "dispatched",
      summary: `Teammate "${definition.id}" was dispatched in the background.`,
      durationMs: 0,
    };
  }

  private async runInBackground(
    definition: RuntimeTeammateDefinition,
    input: Parameters<PilotDeckTeamRuntimeApi["delegate"]>[0],
    action: "run" | "follow_up",
    prompt: string,
  ): Promise<void> {
    try {
      const result = await this.options.host.run({
        leaderSessionId: this.options.leaderSessionId,
        projectRoot: this.options.projectRoot,
        definition,
        action,
        prompt,
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        toolCallId: input.toolCallId,
        permission: input.permission,
        abortSignal: input.abortSignal,
      });
      if (input.taskId) {
        await this.progress.update({
          merge: true,
          items: [{
            id: input.taskId,
            status: result.status === "shutdown" || result.status === "dispatched"
              ? "cancelled"
              : result.status,
            summary: result.summary,
            teammateId: definition.id,
          }],
        });
      }
      await this.reportResultSafely(definition, result.status, result.summary, input.taskId);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      if (input.taskId) {
        await this.progress.update({
          merge: true,
          items: [{
            id: input.taskId,
            status: input.abortSignal?.aborted ? "cancelled" : "failed",
            summary,
            teammateId: definition.id,
          }],
        });
      }
      await this.reportResultSafely(
        definition,
        input.abortSignal?.aborted ? "cancelled" : "failed",
        summary,
        input.taskId,
      );
    } finally {
      this.inFlight.delete(definition.id);
    }
  }

  private async reportResultSafely(
    definition: RuntimeTeammateDefinition,
    status: PilotDeckTeamDelegateResult["status"],
    summary: string,
    taskId?: string,
  ): Promise<void> {
    try {
      await this.reportResult(definition, status, summary, taskId);
    } catch {
      // Message persistence must not rewrite an otherwise valid task result.
      // A later Team runtime reconciliation can only recover messages that
      // reached disk, so this remains best-effort when storage itself fails.
    }
  }

  private async reportResult(
    definition: RuntimeTeammateDefinition,
    status: PilotDeckTeamDelegateResult["status"],
    summary: string,
    taskId?: string,
  ): Promise<void> {
    if (status === "dispatched" || status === "shutdown") return;
    const kind: PilotDeckTeamMessageKind = status === "completed"
      ? "completion"
      : status === "cancelled"
        ? "cancelled"
        : "failure";
    await this.options.messages.enqueue({
      from: {
        role: "teammate",
        id: definition.id,
        sessionId: teammateSessionKey(this.options.leaderSessionId, definition.id),
      },
      to: {
        role: "leader",
        id: "leader",
        sessionId: this.options.leaderSessionId,
      },
      kind,
      text: summary,
      summary: summary.slice(0, 4_096),
      ...(taskId ? { taskId } : {}),
    });
  }
}
