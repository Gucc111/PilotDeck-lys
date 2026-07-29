import { findCatalogProviderById } from './catalogProviders';

export type ModelRefOption = { value: string; label: string };

/**
 * Build a flat list of `provider/model` options from the parsed PilotDeck config.
 * Accepts the `model.providers` map so callers don't need to pass the full config type.
 */
export function buildModelRefOptions(
  providers: Record<string, { models?: Record<string, unknown> }> | undefined,
): ModelRefOption[] {
  if (!providers) return [];
  const out: ModelRefOption[] = [];
  for (const [pid, prov] of Object.entries(providers)) {
    const catalog = findCatalogProviderById(pid);
    const seen = new Set<string>();

    if (catalog) {
      for (const model of catalog.models) {
        seen.add(model.id);
        out.push({
          value: `${pid}/${model.id}`,
          label: `${catalog.displayName}: ${model.displayName}`,
        });
      }
    }

    for (const mid of Object.keys(prov.models ?? {})) {
      if (seen.has(mid)) continue;
      out.push({
        value: `${pid}/${mid}`,
        label: catalog ? `${catalog.displayName}: ${mid}` : `${pid}/${mid}`,
      });
    }
  }
  return out;
}
