import type { CallbackHookHandler } from "../../extension/hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookSyncOutput } from "../../extension/hooks/protocol/output.js";
import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationChannel,
  PilotDeckElicitationRequest,
} from "../../tool/elicitation/PilotDeckElicitationChannel.js";
import type {
  GatewayEvent,
  GatewaySubmitTurnInput,
} from "../../gateway/protocol/types.js";
import type { GatewayPermissionBus } from "../../gateway/permission/GatewayPermissionBus.js";
import type { GatewayElicitationBus } from "../../gateway/elicitation/GatewayElicitationBus.js";
import { GatewayElicitationChannel } from "../../gateway/elicitation/GatewayElicitationChannel.js";
import type { PilotDeckTeamControlRequest } from "../../tool/protocol/types.js";
import { TeamControlCoordinator } from "./TeamControlCoordinator.js";

export const TEAM_PERMISSION_CALLBACK_NAME = "pilotdeck.team.permission";

const CONTROL_BUSY_BACKOFF_MS = [25, 50, 100, 250, 500, 1_000] as const;
const CONTROL_RETRY_COOLDOWN_MS = 2_000;

export type TeamLeaderControlTurnSchedulerOptions = {
  leaderSessionId: string;
  projectRoot: string;
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  shouldRetry?: (request: PilotDeckTeamControlRequest) => boolean | Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  schedule?: (callback: () => void, milliseconds: number) => void;
  busyBackoffMs?: readonly number[];
  retryCooldownMs?: number;
};

/**
 * Serializes synthetic control turns per Leader. Busy responses are streams,
 * not thrown errors, so every internal stream is fully consumed and inspected.
 */
export class TeamLeaderControlTurnScheduler {
  private readonly queue: PilotDeckTeamControlRequest[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly schedule: (callback: () => void, milliseconds: number) => void;
  private draining = false;
  private retryScheduled = false;

  constructor(private readonly options: TeamLeaderControlTurnSchedulerOptions) {
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.schedule = options.schedule ?? ((callback, milliseconds) => {
      setTimeout(callback, milliseconds);
    });
  }

  enqueue(request: PilotDeckTeamControlRequest): void {
    if (this.queuedIds.has(request.id)) return;
    this.queuedIds.add(request.id);
    this.queue.push(request);
    this.start();
  }

  private start(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
      if (this.queue.length > 0 && !this.retryScheduled) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const request = this.queue[0]!;
      if (!await this.submitWithBusyRetry(request)) {
        this.scheduleRetry();
        return;
      }
      this.queue.shift();
      this.queuedIds.delete(request.id);
    }
  }

  private async submitWithBusyRetry(request: PilotDeckTeamControlRequest): Promise<boolean> {
    const backoff = this.options.busyBackoffMs ?? CONTROL_BUSY_BACKOFF_MS;
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      let busy = false;
      try {
        for await (const event of this.options.submitTurn(buildControlTurnInput(
          this.options.leaderSessionId,
          this.options.projectRoot,
          request,
        ))) {
          if (
            (event.type === "agent_status" && event.event === "session_busy")
            || (event.type === "error" && event.code === "session_busy")
          ) {
            busy = true;
          }
        }
      } catch {
        busy = true;
      }
      if (!busy && !await this.options.shouldRetry?.(request)) return true;
      if (attempt < backoff.length) await this.sleep(backoff[attempt]!);
    }
    return false;
  }

  private scheduleRetry(): void {
    if (this.retryScheduled) return;
    this.retryScheduled = true;
    this.schedule(() => {
      this.retryScheduled = false;
      this.start();
    }, this.options.retryCooldownMs ?? CONTROL_RETRY_COOLDOWN_MS);
  }
}

export type TeamControlGatewayEscalationAdapterOptions = {
  coordinator: TeamControlCoordinator;
  leaderSessionId: string;
  permissionBus: GatewayPermissionBus;
  elicitationBus: GatewayElicitationBus;
  emit(event: GatewayEvent): boolean;
  uuid?: () => string;
  log?: (message: string, error?: unknown) => void;
};

/**
 * Adapts a Leader escalation to the existing Gateway permission/elicitation
 * round trips, then writes the user's answer back to the original waiter.
 */
export class TeamControlGatewayEscalationAdapter {
  constructor(private readonly options: TeamControlGatewayEscalationAdapterOptions) {}

  async handle(request: PilotDeckTeamControlRequest): Promise<void> {
    if (request.kind === "permission") {
      await this.handlePermission(request);
      return;
    }
    await this.handlePlan(request);
  }

  private async handlePermission(request: PilotDeckTeamControlRequest): Promise<void> {
    const requestId = this.options.uuid?.() ?? `team-control-${request.id}`;
    const decisionPromise = new Promise<{
      decision: "allow" | "deny";
      reason?: string;
    }>((resolve, reject) => {
      this.options.permissionBus.register(this.options.leaderSessionId, {
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        resolve,
        reject,
      });
    });
    const delivered = this.options.emit({
      type: "permission_request",
      requestId,
      toolName: request.toolName,
      payload: request.permission?.input,
      metadata: escalationMetadata(request),
    });
    if (!delivered) {
      this.options.permissionBus.consume(this.options.leaderSessionId, requestId)?.resolve({
        requestId,
        decision: "deny",
        reason: "Team control escalation could not be delivered because the Leader has no active event sink.",
      });
    }

    try {
      const decision = await decisionPromise;
      await this.options.coordinator.decide({
        requestId: request.id,
        action: decision.decision === "allow" ? "allow_once" : "deny",
        feedback: decision.reason,
      });
    } catch (error) {
      this.options.log?.("Team permission escalation failed; denying the request.", error);
      await this.denyIfWaiting(request, "Team permission escalation was cancelled before a user decision.");
    }
  }

  private async handlePlan(request: PilotDeckTeamControlRequest): Promise<void> {
    let gatewayRequestId: string | undefined;
    let delivered = false;
    const channel = new GatewayElicitationChannel({
      sessionKey: this.options.leaderSessionId,
      bus: this.options.elicitationBus,
      uuid: this.options.uuid,
      emit: (event) => {
        if (event.type === "elicitation_request") gatewayRequestId = event.requestId;
        delivered = this.options.emit(event);
      },
    });
    const answerPromise = channel.askUser({
      toolCallId: request.toolCallId,
      toolName: "exit_plan_mode",
      previewFormat: "markdown",
      questions: [{
        question: "What should happen next?",
        header: "Plan",
        options: [
          {
            label: "continue_planning",
            description: "Request revisions before the Teammate starts implementation.",
          },
          {
            label: "execute_plan",
            description: "Approve the Teammate plan.",
          },
        ],
      }],
      metadata: {
        source: "exit_plan_mode",
        plan: request.plan?.content ?? "",
        planFilePath: request.plan?.filePath,
        ...escalationMetadata(request),
      },
    });
    if (!delivered && gatewayRequestId) {
      this.options.elicitationBus
        .consume(this.options.leaderSessionId, gatewayRequestId)
        ?.resolve({ type: "cancelled", reason: "Leader has no active event sink." });
    }

    try {
      const answer = await answerPromise;
      const action = exitPlanAction(answer);
      if (answer.type === "cancelled" || !action) {
        await this.options.coordinator.cancelRequest(
          request.id,
          answer.type === "cancelled"
            ? answer.reason ?? "User cancelled the plan escalation."
            : "Plan escalation returned no valid action.",
        );
        return;
      }
      await this.options.coordinator.decide({
        requestId: request.id,
        action: action === "execute_plan" ? "approve_plan" : "request_revision",
        feedback: exitPlanFeedback(answer),
      });
    } catch (error) {
      this.options.log?.("Team plan escalation failed; cancelling the request.", error);
      await this.cancelIfWaiting(request, "Team plan escalation ended before a user decision.");
    }
  }

  private async denyIfWaiting(request: PilotDeckTeamControlRequest, reason: string): Promise<void> {
    try {
      await this.options.coordinator.decide({
        requestId: request.id,
        action: "deny",
        feedback: reason,
      });
    } catch {
      // The originating turn may already have been aborted and cancelled.
    }
  }

  private async cancelIfWaiting(request: PilotDeckTeamControlRequest, reason: string): Promise<void> {
    try {
      await this.options.coordinator.cancelRequest(request.id, reason);
    } catch {
      // The originating turn may already have been aborted and cancelled.
    }
  }
}

export function createTeamPermissionHook(input: {
  coordinator: TeamControlCoordinator;
  teammateId: string;
  teammateSessionId: string;
  getTaskId?: () => string | undefined;
}): CallbackHookHandler {
  return async ({ hookInput, signal }) => {
    const toolName = typeof hookInput.toolName === "string" ? hookInput.toolName : "UnknownTool";
    const toolCallId = typeof hookInput.toolCallId === "string"
      ? hookInput.toolCallId
      : typeof hookInput.toolUseId === "string"
        ? hookInput.toolUseId
        : "";
    const toolInput = "toolInput" in hookInput
      ? hookInput.toolInput
      : "input" in hookInput
        ? hookInput.input
        : {};
    const resolution = await input.coordinator.requestPermission({
      teammateId: input.teammateId,
      teammateSessionId: input.teammateSessionId,
      taskId: input.getTaskId?.(),
      toolCallId,
      toolName,
      toolInput,
      suggestions: Array.isArray(hookInput.permissionSuggestions)
        ? hookInput.permissionSuggestions
        : undefined,
      signal,
    });

    return {
      type: "sync",
      specific: {
        hookEventName: "PermissionRequest",
        decision: resolution.action === "allow_once"
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message: resolution.action === "deny"
                ? resolution.reason ?? `Team Leader denied ${toolName}.`
                : resolution.reason ?? `Team permission request for ${toolName} was cancelled.`,
            },
      },
    } satisfies PilotDeckHookSyncOutput;
  };
}

export function createTeamPlanElicitationChannel(input: {
  coordinator: TeamControlCoordinator;
  teammateId: string;
  teammateSessionId: string;
  getTaskId?: () => string | undefined;
}): PilotDeckElicitationChannel {
  return {
    async askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer> {
      if (request.toolName !== "exit_plan_mode" || request.metadata?.source !== "exit_plan_mode") {
        return {
          type: "cancelled",
          reason: `Teammate elicitation only supports exit_plan_mode, received ${request.toolName}.`,
        };
      }
      const plan = typeof request.metadata.plan === "string" ? request.metadata.plan : "";
      const planFilePath = typeof request.metadata.planFilePath === "string"
        ? request.metadata.planFilePath
        : undefined;
      const resolution = await input.coordinator.requestPlan({
        teammateId: input.teammateId,
        teammateSessionId: input.teammateSessionId,
        taskId: input.getTaskId?.(),
        toolCallId: request.toolCallId,
        plan,
        planFilePath,
        signal: request.signal,
      });
      if (resolution.action === "cancelled") {
        return { type: "cancelled", reason: resolution.reason };
      }

      const question = request.questions[0]?.question ?? "What should happen next?";
      if (resolution.action === "approve_plan") {
        return {
          type: "answered",
          answers: { [question]: "execute_plan" },
        };
      }
      return {
        type: "answered",
        answers: { [question]: "continue_planning" },
        ...(resolution.feedback
          ? { annotations: { [question]: { notes: resolution.feedback } } }
          : {}),
      };
    },
  };
}

function buildControlTurnInput(
  leaderSessionId: string,
  projectRoot: string,
  request: PilotDeckTeamControlRequest,
): GatewaySubmitTurnInput {
  const controlMessage = {
    type: "pilotdeck.team.control_request",
    requestId: request.id,
    kind: request.kind,
    teammate: {
      id: request.teammateId,
      sessionId: request.teammateSessionId,
    },
    taskId: request.taskId,
    tool: {
      callId: request.toolCallId,
      name: request.toolName,
    },
    input: request.permission?.input,
    plan: request.plan,
  };
  return {
    sessionKey: leaderSessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "team_control",
    runMode: "team",
    mode: "default",
    basePermissionMode: "default",
    canPrompt: true,
    message: "",
    syntheticMessages: [{
      purpose: "team_control_request",
      text: [
        "[PilotDeck internal Team control request]",
        JSON.stringify(controlMessage),
        "Use delegate_to_teammate with this requestId to decide it now. Do not delegate new work in this control turn.",
      ].join("\n"),
    }],
  };
}

function escalationMetadata(request: PilotDeckTeamControlRequest): Record<string, unknown> {
  return {
    originSessionKey: request.teammateSessionId,
    teammateId: request.teammateId,
    taskId: request.taskId,
    controlRequestId: request.id,
  };
}

function exitPlanAction(
  answer: PilotDeckElicitationAnswer,
): "continue_planning" | "execute_plan" | undefined {
  if (answer.type !== "answered") return undefined;
  for (const value of Object.values(answer.answers)) {
    if (Array.isArray(value)) {
      const action = value.find(
        (entry) => entry === "continue_planning" || entry === "execute_plan",
      );
      if (action) return action;
    } else if (value === "continue_planning" || value === "execute_plan") {
      return value;
    }
  }
  return undefined;
}

function exitPlanFeedback(answer: PilotDeckElicitationAnswer): string | undefined {
  if (answer.type !== "answered") return undefined;
  for (const annotation of Object.values(answer.annotations ?? {})) {
    if (annotation?.notes?.trim()) return annotation.notes.trim();
  }
  return undefined;
}
