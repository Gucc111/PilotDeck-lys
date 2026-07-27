import { randomUUID } from "node:crypto";
import type {
  PilotDeckTeamMessage,
  PilotDeckTeamMessageActor,
  PilotDeckTeamMessageKind,
  PilotDeckTeamLifecycleStatus,
  PilotDeckTeamPermissionSnapshot,
} from "../../tool/protocol/types.js";
import { TeamMessageStore } from "./TeamMessageStore.js";

export type TeamMessageCoordinatorOptions = {
  path: string;
  leaderSessionId: string;
  now?: () => Date;
  uuid?: () => string;
  onPending?: (message: PilotDeckTeamMessage) => void;
};

export class TeamMessageCoordinator {
  private readonly store: TeamMessageStore;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(private readonly options: TeamMessageCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.store = new TeamMessageStore({ path: options.path, now: this.now });
  }

  async enqueue(input: {
    from: PilotDeckTeamMessageActor;
    to: PilotDeckTeamMessageActor;
    kind: PilotDeckTeamMessageKind;
    text: string;
    summary?: string;
    taskId?: string;
    lifecycleId?: string;
    lifecycleStatus?: PilotDeckTeamLifecycleStatus;
    permission?: PilotDeckTeamPermissionSnapshot;
  }): Promise<PilotDeckTeamMessage> {
    const timestamp = this.now().toISOString();
    const message = await this.store.enqueue({
      id: input.lifecycleId ?? this.uuid(),
      leaderSessionId: this.options.leaderSessionId,
      from: input.from,
      to: input.to,
      kind: input.kind,
      text: input.text,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.lifecycleId ? { lifecycleId: input.lifecycleId } : {}),
      ...(input.lifecycleStatus
        ? { lifecycleStatus: input.lifecycleStatus }
        : {}),
      ...(input.permission ? { permission: input.permission } : {}),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (message.status === "pending") this.options.onPending?.(message);
    return message;
  }

  listPending(recipient?: PilotDeckTeamMessageActor) {
    return this.store.listPending(recipient);
  }

  markDelivered(messageIds: string[]) {
    return this.store.markDelivered(messageIds);
  }

  markFailed(messageIds: string[], failureReason: string) {
    return this.store.markFailed(messageIds, failureReason);
  }

  async reconcile(): Promise<void> {
    for (const message of await this.store.listPending()) {
      this.options.onPending?.(message);
    }
  }
}
