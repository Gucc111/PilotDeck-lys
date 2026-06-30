import type { GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import type {
  AlwaysOnDiscoveryOutcome,
  AlwaysOnEventPhase,
} from "../../protocol/types.js";

export type AlwaysOnTelemetryPhase = "discovery" | "workspace" | "execution" | "report" | "apply";

export type PhaseEventExtra = {
  title?: string;
  planId?: string;
  outcome?: AlwaysOnDiscoveryOutcome;
  error?: { code: string; message: string };
  message?: string;
  disabledReason?: { stage: string; code: string; message: string };
  telemetryPhase?: AlwaysOnTelemetryPhase;
};

export type AgentTurnInput = {
  sessionKey: string;
  channelKey: GatewayChannelKey;
  runId: string;
  message: string;
  mode: "default" | "bypassPermissions";
};

export type AgentTurnResult = {
  events: GatewayEvent[];
};

export type PhaseError = {
  code?: string;
  message: string;
};

export type DisableAlwaysOnStage = "discovery" | "workspace" | "execution" | "internal";

export type DisableAlwaysOnProject = (input: {
  projectKey: string;
  stage: DisableAlwaysOnStage;
  runId: string;
  planId?: string;
  error: { code: string; message: string };
}) => Promise<void>;

export type AlwaysOnPhaseHandler = {
  emit(runId: string, phase: AlwaysOnEventPhase, extra?: PhaseEventExtra): void;
};
