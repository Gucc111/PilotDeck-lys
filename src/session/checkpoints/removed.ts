/** Compatibility contract only. Checkpoint storage is deliberately never opened. */
export type CheckpointRequest = { projectKey?: string; sessionKey?: string; action?: string; [key: string]: unknown };
