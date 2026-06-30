import type { PilotConfigDiagnostic } from "../../../pilot/config/types.js";

export function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

export function positiveNumber(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a positive number; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}

export function nonNegativeNumber(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a non-negative number; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a positive integer; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}

export function nonNegativeInteger(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    diagnostics.push({
      code: "ALWAYS_ON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a non-negative integer; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}
