export type McpOwner = { sessionKey: string; activationId?: string; participantId?: string; stopVersion?: number };
export type McpState = "connecting" | "waiting_capacity" | "waiting_call" | "ready" | "failed" | "unknown";
export type McpStatus = {
  serverId: string; resourceId: string; state: McpState; stage: "capacity" | "connect" | "tools" | "call" | "cleanup";
  owner?: McpOwner; holders: McpOwner[]; retryable?: boolean; reason?: string; connectionId?: string; busy?: boolean;
};

export type McpManagementInput = { action: "status" } | { action: "release" | "cancel"; owner: McpOwner } | { action: "reset"; resourceId: string };
export type McpManagementResult = { statuses: McpStatus[] };
