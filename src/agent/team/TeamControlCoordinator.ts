import { randomUUID } from "node:crypto";
import type {
  PilotDeckTeamControlDecisionAction,
  PilotDeckTeamControlRequest,
  PilotDeckTeamControlRequestKind,
  PilotDeckTeamControlRequestStatus,
} from "../../tool/protocol/types.js";
import { TeamControlStore } from "./TeamControlStore.js";

export type TeamPermissionResolution =
  | { action: "allow_once" }
  | { action: "deny"; reason?: string }
  | { action: "cancelled"; reason?: string };

export type TeamPlanResolution =
  | { action: "approve_plan" }
  | { action: "request_revision"; feedback?: string }
  | { action: "cancelled"; reason?: string };

type TeamControlResolution = TeamPermissionResolution | TeamPlanResolution;

export type TeamControlCoordinatorOptions = {
  path: string;
  leaderSessionId: string;
  now?: () => Date;
  uuid?: () => string;
  onPending?: (request: PilotDeckTeamControlRequest) => void | Promise<void>;
  onEscalation?: (request: PilotDeckTeamControlRequest) => void | Promise<void>;
};

type PendingResolver = {
  resolve: (resolution: TeamControlResolution) => void;
};

export class TeamControlCoordinator {
  private readonly store: TeamControlStore;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly pending = new Map<string, PendingResolver>();
  private readonly recovery: Promise<number>;

  constructor(private readonly options: TeamControlCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.store = new TeamControlStore({ path: options.path, now: this.now });
    this.recovery = this.reconcilePersistedRequests();
  }

  /**
   * Cancel requests restored from disk because their in-memory waiter was
   * owned by the previous process and cannot be resumed after a restart.
   */
  reconcile(): Promise<number> {
    return this.recovery;
  }

  async list(input: {
    status?: PilotDeckTeamControlRequestStatus;
    kind?: PilotDeckTeamControlRequestKind;
  } = {}): Promise<PilotDeckTeamControlRequest[]> {
    await this.recovery;
    const snapshot = await this.store.read();
    return snapshot.requests.filter((request) =>
      (!input.status || request.status === input.status)
      && (!input.kind || request.kind === input.kind)
    );
  }

  async read(requestId: string): Promise<PilotDeckTeamControlRequest | undefined> {
    await this.recovery;
    return (await this.store.read()).requests.find((request) => request.id === requestId);
  }

  requestPermission(input: {
    teammateId: string;
    teammateSessionId: string;
    taskId?: string;
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
    suggestions?: unknown[];
    signal?: AbortSignal;
  }): Promise<TeamPermissionResolution> {
    return this.createAndWait({
      kind: "permission",
      teammateId: input.teammateId,
      teammateSessionId: input.teammateSessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      permission: {
        input: input.toolInput,
        ...(input.suggestions ? { suggestions: input.suggestions } : {}),
      },
    }, input.signal) as Promise<TeamPermissionResolution>;
  }

  requestPlan(input: {
    teammateId: string;
    teammateSessionId: string;
    taskId?: string;
    toolCallId: string;
    plan: string;
    planFilePath?: string;
    signal?: AbortSignal;
  }): Promise<TeamPlanResolution> {
    return this.createAndWait({
      kind: "plan",
      teammateId: input.teammateId,
      teammateSessionId: input.teammateSessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      toolCallId: input.toolCallId,
      toolName: "exit_plan_mode",
      plan: {
        content: input.plan,
        ...(input.planFilePath ? { filePath: input.planFilePath } : {}),
      },
    }, input.signal) as Promise<TeamPlanResolution>;
  }

  async decide(input: {
    requestId: string;
    action: PilotDeckTeamControlDecisionAction;
    feedback?: string;
  }): Promise<PilotDeckTeamControlRequest> {
    await this.recovery;
    const waiter = this.pending.get(input.requestId);
    if (!waiter) {
      throw new Error(
        `Team control request "${input.requestId}" has no active waiter and cannot be decided.`,
      );
    }
    const request = await this.store.update(input.requestId, (current) => {
      assertActionMatchesKind(current, input.action);
      if (current.status !== "pending" && current.status !== "escalated") {
        throw new Error(`Team control request "${current.id}" is already ${current.status}.`);
      }
      return {
        ...current,
        status: "decided",
        decision: {
          action: input.action,
          ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
        },
        updatedAt: this.now().toISOString(),
      };
    });

    waiter.resolve(toResolution(request));
    return request;
  }

  async escalate(requestId: string, reason?: string): Promise<PilotDeckTeamControlRequest> {
    await this.recovery;
    if (!this.pending.has(requestId)) {
      throw new Error(
        `Team control request "${requestId}" has no active waiter and cannot be escalated.`,
      );
    }
    const request = await this.store.update(requestId, (current) => {
      if (current.status !== "pending" && current.status !== "escalated") {
        throw new Error(`Team control request "${current.id}" cannot be escalated from ${current.status}.`);
      }
      return {
        ...current,
        status: "escalated",
        escalation: {
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          requestedAt: this.now().toISOString(),
        },
        updatedAt: this.now().toISOString(),
      };
    });
    if (this.options.onEscalation) {
      await this.options.onEscalation(request);
    }
    return request;
  }

  async cancelRequest(requestId: string, reason: string): Promise<PilotDeckTeamControlRequest> {
    await this.recovery;
    const waiter = this.pending.get(requestId);
    const request = await this.store.update(requestId, (current) =>
      current.status === "pending" || current.status === "escalated"
        ? {
            ...current,
            status: "cancelled",
            updatedAt: this.now().toISOString(),
          }
        : current);
    waiter?.resolve({ action: "cancelled", reason });
    return request;
  }

  private async createAndWait(
    input: Omit<PilotDeckTeamControlRequest, "id" | "leaderSessionId" | "status" | "createdAt" | "updatedAt">,
    signal?: AbortSignal,
  ): Promise<TeamControlResolution> {
    await this.recovery;
    const timestamp = this.now().toISOString();
    const request: PilotDeckTeamControlRequest = {
      ...input,
      id: this.uuid(),
      leaderSessionId: this.options.leaderSessionId,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let resolvePromise!: (resolution: TeamControlResolution) => void;
    const promise = new Promise<TeamControlResolution>((resolve) => {
      resolvePromise = resolve;
    });
    this.pending.set(request.id, { resolve: resolvePromise });

    const onAbort = () => {
      void this.cancel(request.id, "Teammate control request was aborted.").catch(() => undefined);
    };
    try {
      await this.store.put(request);
      if (signal) {
        if (signal.aborted) await this.cancel(request.id, "Teammate control request was aborted.");
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      if (!signal?.aborted) this.notify(this.options.onPending, request);
      const resolution = await promise;
      if (resolution.action !== "cancelled") {
        await this.markResolved(request.id);
      }
      return resolution;
    } catch (error) {
      this.pending.delete(request.id);
      throw error;
    } finally {
      this.pending.delete(request.id);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  private async cancel(requestId: string, reason: string): Promise<void> {
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    try {
      await this.cancelRequest(requestId, reason);
    } finally {
      waiter.resolve({ action: "cancelled", reason });
    }
  }

  private markResolved(requestId: string): Promise<PilotDeckTeamControlRequest> {
    return this.store.update(requestId, (current) =>
      current.status === "decided"
        ? {
            ...current,
            status: "resolved",
            updatedAt: this.now().toISOString(),
          }
        : current);
  }

  private notify(
    callback: ((request: PilotDeckTeamControlRequest) => void | Promise<void>) | undefined,
    request: PilotDeckTeamControlRequest,
  ): void {
    if (!callback) return;
    void Promise.resolve(callback(request)).catch(() => undefined);
  }

  private async reconcilePersistedRequests(): Promise<number> {
    const snapshot = await this.store.read();
    const stale = snapshot.requests.filter(
      (request) => request.status === "pending" || request.status === "escalated",
    );
    for (const request of stale) {
      await this.store.update(request.id, (current) =>
        current.status === "pending" || current.status === "escalated"
          ? {
              ...current,
              status: "cancelled",
              updatedAt: this.now().toISOString(),
            }
          : current);
    }
    return stale.length;
  }
}

function assertActionMatchesKind(
  request: PilotDeckTeamControlRequest,
  action: PilotDeckTeamControlDecisionAction,
): void {
  const permissionAction = action === "allow_once" || action === "deny";
  if ((request.kind === "permission") !== permissionAction) {
    throw new Error(`Action "${action}" is not valid for ${request.kind} request "${request.id}".`);
  }
}

function toResolution(request: PilotDeckTeamControlRequest): TeamControlResolution {
  const decision = request.decision;
  if (!decision) throw new Error(`Team control request "${request.id}" has no decision.`);
  switch (decision.action) {
    case "allow_once":
      return { action: "allow_once" };
    case "deny":
      return { action: "deny", ...(decision.feedback ? { reason: decision.feedback } : {}) };
    case "approve_plan":
      return { action: "approve_plan" };
    case "request_revision":
      return {
        action: "request_revision",
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      };
  }
}
