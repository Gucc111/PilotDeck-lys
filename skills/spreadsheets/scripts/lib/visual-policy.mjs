const FULL_REVIEW_TYPES = new Set(["dashboard", "report", "template"]);

export function selectAdaptiveSheets(signals, { maxSheets = 8 } = {}) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  if (signals.length <= maxSheets) return signals.map((item) => item.name);
  const ranked = signals.map((item, index) => ({
    ...item,
    index,
    score: (item.hasChart ? 1000 : 0)
      + (item.formulaCount > 0 ? 500 : 0)
      + (item.required ? 250 : 0)
      + (index === 0 ? 200 : 0)
      + (index === signals.length - 1 ? 150 : 0)
      + Math.min(100, Math.log10(Math.max(1, item.rowCount ?? 0) + 1) * 20),
  }));
  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxSheets)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.name);
}

export function selectReviewPages(pageStats, task) {
  if (!Array.isArray(pageStats) || pageStats.length === 0) return [];
  const mode = task?.visualReview?.mode ?? "adaptive";
  if (mode === "structural-only") return [];
  if (mode === "all-pages" || mode === "selected-sheets" || FULL_REVIEW_TYPES.has(task?.workbookType) || pageStats.length <= 3) {
    return [...pageStats];
  }
  const bySheet = new Map();
  for (const page of pageStats) {
    const pages = bySheet.get(page.sheet) ?? [];
    pages.push(page);
    bySheet.set(page.sheet, pages);
  }
  const selected = [];
  for (const pages of bySheet.values()) {
    selected.push(pages[0]);
    if (pages.length > 1) selected.push(pages.at(-1));
  }
  return selected;
}
