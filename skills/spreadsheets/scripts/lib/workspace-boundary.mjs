export const PROJECT_GUARD_PROTOCOL = "pilotdeck-spreadsheet-project-guard/v2";

const ALWAYS_INTERNAL_SEGMENTS = new Set([".tmp_src", ".tmp_csv"]);
const SUSPICIOUS_FILES = [
  /^\.pilotdeck_build/i,
  /^build[_-].*\.mjs$/i,
  /(?:builder|requirements|integrity-plan|source-evidence|numeric-integrity|attestation|visual-review|delivery|delivery-report)\.(?:mjs|json)$/i,
  /(?:inspect|audit|build-report)\.json$/i,
];
const RENDER_ARTIFACTS = [/^page-\d+\.png$/i, /^montage\.png$/i, /^workbook\.pdf$/i];

export function isSuspiciousSpreadsheetArtifact(relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => ALWAYS_INTERNAL_SEGMENTS.has(segment.toLowerCase()))) return true;
  const basename = segments.at(-1) ?? "";
  const hasRenderDirectory = segments.slice(0, -1).some((segment) => ["render", "renders"].includes(segment.toLowerCase()));
  if (hasRenderDirectory && RENDER_ARTIFACTS.some((pattern) => pattern.test(basename))) return true;
  return SUSPICIOUS_FILES.some((pattern) => pattern.test(basename));
}

export function compareProjectGuard(before, after) {
  const beforePaths = new Set((before.files ?? []).map((item) => item.path));
  const created = (after.files ?? []).filter((item) => !beforePaths.has(item.path));
  const suspicious = created.filter((item) => isSuspiciousSpreadsheetArtifact(item.path));
  return { clean: suspicious.length === 0, created, suspicious };
}
