export function deriveDiscoverySessionKey(projectKey: string, runId: string): string {
  return `always-on/discovery:project=${projectKey}:run=${runId}`;
}

export function deriveExecutionSessionKey(projectKey: string, runId: string): string {
  return `always-on/execute:project=${projectKey}:run=${runId}`;
}

export function deriveReportSessionKey(projectKey: string, runId: string): string {
  return `always-on/report:project=${projectKey}:run=${runId}`;
}

export function deriveApplySessionKey(projectKey: string, runId: string): string {
  return `always-on/apply:project=${projectKey}:run=${runId}`;
}
