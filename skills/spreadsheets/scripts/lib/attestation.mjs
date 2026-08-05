export const SPREADSHEET_ATTESTATION_PROTOCOL = "pilotdeck-spreadsheet-attestation/v2";

function requireBinding(binding, label) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error(`${label} must be an object`);
  if (typeof binding.path !== "string" || binding.path.length === 0) throw new Error(`${label}.path must be non-empty`);
  if (!/^[a-f0-9]{64}$/i.test(String(binding.sha256 ?? ""))) throw new Error(`${label}.sha256 must be a SHA-256 hash`);
}

export function validateSpreadsheetAttestation(attestation, label = "spreadsheet attestation") {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) throw new Error(`${label} must be an object`);
  if (attestation.protocol !== SPREADSHEET_ATTESTATION_PROTOCOL) {
    throw new Error(`${label}.protocol must be '${SPREADSHEET_ATTESTATION_PROTOCOL}'`);
  }
  if (!['fast', 'standard', 'strict'].includes(attestation.profile)) throw new Error(`${label}.profile is invalid`);
  for (const [name, binding] of [["candidate", attestation.candidate], ["requirements", attestation.requirements], ["builder", attestation.builder]]) {
    requireBinding(binding, `${label}.${name}`);
  }
  if (!Array.isArray(attestation.sources)) throw new Error(`${label}.sources must be an array`);
  attestation.sources.forEach((binding, index) => requireBinding(binding, `${label}.sources[${index}]`));
  if (attestation.evidence !== null && attestation.evidence !== undefined) requireBinding(attestation.evidence, `${label}.evidence`);
  if (attestation.plan !== null && attestation.plan !== undefined) requireBinding(attestation.plan, `${label}.plan`);
  if (!attestation.audit || typeof attestation.audit !== "object" || Array.isArray(attestation.audit)) throw new Error(`${label}.audit must be an object`);
  if (!['ok', 'partial'].includes(attestation.audit.status)) throw new Error(`${label}.audit.status must be ok or partial`);
  return attestation;
}

export function compareAttestationBindings(attestation, actual, { includeExternal = true } = {}) {
  validateSpreadsheetAttestation(attestation);
  const failures = [];
  const compare = (name, expected, observed) => {
    if (!observed || typeof observed.sha256 !== "string" || expected.path !== observed.path || expected.sha256.toLowerCase() !== observed.sha256.toLowerCase()) {
      failures.push({ name, expected, actual: observed ?? null });
    }
  };
  compare("candidate", attestation.candidate, actual.candidate);
  compare("requirements", attestation.requirements, actual.requirements);
  if (actual.builder) compare("builder", attestation.builder, actual.builder);
  if (includeExternal) {
    const sources = new Map((actual.sources ?? []).map((item) => [item.path, item]));
    for (const expected of attestation.sources) compare(`source:${expected.path}`, expected, sources.get(expected.path));
    if (attestation.evidence) compare("evidence", attestation.evidence, actual.evidence);
    if (attestation.plan) compare("plan", attestation.plan, actual.plan);
  }
  return failures;
}
