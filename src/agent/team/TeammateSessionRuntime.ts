import type {
  PilotDeckTeamDelegateResult,
  PilotDeckTeamRuntimeApi,
} from "../../tool/protocol/types.js";
import { TeamProgressStore } from "./TeamProgressStore.js";
import type { RuntimeTeammateDefinition } from "./types.js";

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
  definitions: () => RuntimeTeammateDefinition[];
  host: TeammateTurnHost;
  now?: () => Date;
};

export class TeammateSessionRuntime implements PilotDeckTeamRuntimeApi {
  private readonly progress: TeamProgressStore;

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

  readProgress() {
    return this.progress.read();
  }

  updateProgress(input: Parameters<PilotDeckTeamRuntimeApi["updateProgress"]>[0]) {
    return this.progress.update(input);
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
    try {
      const result = await this.options.host.run({
        leaderSessionId: this.options.leaderSessionId,
        projectRoot: this.options.projectRoot,
        definition,
        action: input.action,
        prompt,
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        toolCallId: input.toolCallId,
        abortSignal: input.abortSignal,
      });
      if (input.taskId) {
        await this.progress.update({
          merge: true,
          items: [{
            id: input.taskId,
            status: result.status === "shutdown" ? "cancelled" : result.status,
            summary: result.summary,
            teammateId: definition.id,
          }],
        });
      }
      return result;
    } catch (error) {
      if (input.taskId) {
        await this.progress.update({
          merge: true,
          items: [{
            id: input.taskId,
            status: input.abortSignal?.aborted ? "cancelled" : "failed",
            summary: error instanceof Error ? error.message : String(error),
            teammateId: definition.id,
          }],
        });
      }
      throw error;
    }
  }
}
