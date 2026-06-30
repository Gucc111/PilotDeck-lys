import type { AlwaysOnChannelLease, WorkspaceHandle } from "../infra/storage/types.js";

export type GateBlockReason =
  | "disabled"
  | "project_disabled"
  | "project_missing"
  | "dormant_no_signal"
  | "agent_busy"
  | "recent_user_msg"
  | "cooldown"
  | "daily_budget"
  | "lock_busy"
  | "cycle_full";

export type GateResult =
  | { ok: true; lease?: AlwaysOnChannelLease }
  | { ok: false; reason: GateBlockReason };

export type AlwaysOnPipelineResult =
  | {
      outcome: "no_plan";
      runId: string;
      startedAt: string;
      finishedAt: string;
    }
  | {
      outcome: "executed" | "failed" | "aborted";
      runId: string;
      startedAt: string;
      finishedAt: string;
      planId: string;
      workspace?: WorkspaceHandle;
      reportFilePath?: string;
      error?: { code: string; message: string };
    };
