export const VALIDATION_PROFILES = Object.freeze(["fast", "standard", "strict"]);
export const DATA_OPERATIONS = Object.freeze(["create", "presentation-only", "copy", "union", "transform", "ocr"]);

const PROFILE_RANK = new Map(VALIDATION_PROFILES.map((profile, index) => [profile, index]));

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}

export function minimumProfileForOperation(operation) {
  requireEnum(operation, DATA_OPERATIONS, "data operation");
  if (["transform", "ocr"].includes(operation)) return "strict";
  if (["copy", "union"].includes(operation)) return "standard";
  return "fast";
}

export function deriveTaskProfile({
  requestedProfile = null,
  dataOperation,
  sourceCount = 0,
  hasImageSources = false,
  hasInput = false,
} = {}) {
  requireEnum(dataOperation, DATA_OPERATIONS, "data operation");
  if (requestedProfile !== null) requireEnum(requestedProfile, VALIDATION_PROFILES, "validation profile");
  if (["copy", "union", "transform", "ocr"].includes(dataOperation) && sourceCount === 0) {
    throw new Error(`data operation '${dataOperation}' requires at least one --source`);
  }
  if (dataOperation === "presentation-only" && !hasInput) {
    throw new Error("data operation 'presentation-only' requires --input");
  }
  if (hasImageSources && dataOperation !== "ocr") {
    throw new Error("Image fact sources require --data-operation ocr");
  }
  if (dataOperation === "ocr" && !hasImageSources) {
    throw new Error("data operation 'ocr' requires at least one image --source");
  }
  const minimumProfile = minimumProfileForOperation(dataOperation);
  const profile = requestedProfile ?? minimumProfile;
  if (PROFILE_RANK.get(profile) < PROFILE_RANK.get(minimumProfile)) {
    throw new Error(`validation profile '${profile}' is below the '${minimumProfile}' minimum for '${dataOperation}'`);
  }
  const reasons = [`${dataOperation} requires at least ${minimumProfile} validation`];
  if (profile !== minimumProfile) reasons.push(`validation was explicitly escalated to ${profile}`);
  if (sourceCount > 0) reasons.push(`${sourceCount} source file(s) are frozen`);
  if (hasImageSources) reasons.push("image-derived facts require evidence binding");
  return { profile, minimumProfile, dataOperation, reasons };
}

export function defaultDataOperation({ sourceCount = 0, hasImageSources = false, hasInput = false } = {}) {
  if (hasImageSources) return "ocr";
  if (sourceCount > 0) return "transform";
  if (hasInput) return "presentation-only";
  return "create";
}

export function profileAtLeast(profile, minimum) {
  requireEnum(profile, VALIDATION_PROFILES, "validation profile");
  requireEnum(minimum, VALIDATION_PROFILES, "minimum validation profile");
  return PROFILE_RANK.get(profile) >= PROFILE_RANK.get(minimum);
}
