import type {
  PilotDeckTeamControlDecisionAction,
  PilotDeckTeamDelegateResult,
  PilotDeckTeamLifecycleStatus,
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
    teammateSessionId: string;
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
  actorSessionId?: string;
  resolveTeammateSessionId?: (input: {
    definition: RuntimeTeammateDefinition;
    action: "run" | "follow_up" | "message";
  }) => string;
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
      contextPolicy: definition.contextPolicy,
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
        sessionId: this.options.actorSessionId
          ?? teammateSessionKey(this.options.leaderSessionId, actorTeammateId),
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
      sessionId: this.resolveTeammateSessionId(definition, "message"),
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
    const teammateSessionId = this.resolveTeammateSessionId(definition, input.action);
    if (input.taskId) {
      const existing = (await this.progress.read()).items.find(
        (item) => item.id === input.taskId,
      );
      await this.progress.update({
        merge: true,
        items: [{
          id: input.taskId,
          subject: existing?.subject ?? subjectFromPrompt(prompt),
          ...(
            input.action === "run" || !existing?.briefing
              ? { briefing: prompt }
              : {}
          ),
          status: "in_progress",
          teammateId: definition.id,
        }],
      });
    }
    this.inFlight.add(definition.id);
    void this.runInBackground(definition, input, input.action, prompt, teammateSessionId);
    return {
      teammateId: definition.id,
      teammateSessionId,
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
    teammateSessionId: string,
  ): Promise<void> {
    try {
      const result = await this.options.host.run({
        leaderSessionId: this.options.leaderSessionId,
        projectRoot: this.options.projectRoot,
        definition,
        teammateSessionId,
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
            summary: result.status === "completed"
              ? null
              : result.summary.slice(0, 1_000),
            teammateId: definition.id,
          }],
        });
      }
      await this.reportIdleSafely(
        definition,
        result.status,
        result.summary,
        input.taskId,
        result.teammateSessionId,
        lifecycleIdFor(input, definition.id, this.options.leaderSessionId),
      );
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      if (input.taskId) {
        await this.progress.update({
          merge: true,
          items: [{
            id: input.taskId,
            status: input.abortSignal?.aborted ? "cancelled" : "failed",
            summary: summary.slice(0, 1_000),
            teammateId: definition.id,
          }],
        });
      }
      await this.reportIdleSafely(
        definition,
        input.abortSignal?.aborted ? "cancelled" : "failed",
        summary,
        input.taskId,
        teammateSessionId,
        lifecycleIdFor(input, definition.id, this.options.leaderSessionId),
      );
    } finally {
      this.inFlight.delete(definition.id);
    }
  }

  private async reportIdleSafely(
    definition: RuntimeTeammateDefinition,
    status: PilotDeckTeamDelegateResult["status"],
    summary: string,
    taskId?: string,
    teammateSessionId?: string,
    lifecycleId?: string,
  ): Promise<void> {
    try {
      await this.reportIdle(definition, status, summary, taskId, teammateSessionId, lifecycleId);
    } catch {
      // Lifecycle persistence must not rewrite an otherwise valid task result.
    }
  }

  private async reportIdle(
    definition: RuntimeTeammateDefinition,
    status: PilotDeckTeamDelegateResult["status"],
    summary: string,
    taskId?: string,
    teammateSessionId?: string,
    lifecycleId?: string,
  ): Promise<void> {
    if (status === "dispatched" || status === "shutdown") return;
    const lifecycleStatus: PilotDeckTeamLifecycleStatus = status === "completed"
      ? "available"
      : status === "cancelled"
        ? "cancelled"
        : "failed";
    const text = lifecycleStatus === "available"
      ? `Teammate "${definition.id}" is idle.`
      : `Teammate "${definition.id}" is idle after ${lifecycleStatus}: ${summary.slice(0, 1_000)}`;
    await this.options.messages.enqueue({
      from: {
        role: "teammate",
        id: definition.id,
        sessionId: teammateSessionId
          ?? teammateSessionKey(this.options.leaderSessionId, definition.id),
      },
      to: {
        role: "leader",
        id: "leader",
        sessionId: this.options.leaderSessionId,
      },
      kind: "idle",
      text,
      ...(taskId ? { taskId } : {}),
      ...(lifecycleId ? { lifecycleId } : {}),
      lifecycleStatus,
    });
  }

  private resolveTeammateSessionId(
    definition: RuntimeTeammateDefinition,
    action: "run" | "follow_up" | "message",
  ): string {
    return this.options.resolveTeammateSessionId?.({ definition, action })
      ?? teammateSessionKey(this.options.leaderSessionId, definition.id);
  }
}

function subjectFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "Team task";
  return firstLine.slice(0, 160);
}

function lifecycleIdFor(
  input: Parameters<PilotDeckTeamRuntimeApi["delegate"]>[0],
  teammateId: string,
  leaderSessionId: string,
): string {
  const sourceId = [
    input.toolCallId ?? input.parentTurnId,
    input.action,
    input.taskId ?? "no-task",
  ].join(":");
  return `team-lifecycle:${leaderSessionId}:${teammateId}:${sourceId}`;
}
